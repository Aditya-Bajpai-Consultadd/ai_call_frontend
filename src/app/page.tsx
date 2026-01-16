"use client";
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import PermissionStatus from "./components/PermissionStatus";
import CallControls from "./components/CallControls";
import Instructions from "./components/Instructions";

interface Transcript {
  text: string;
  speaker: string;
  speakerRole?: string;
  timestamp: string;
}

interface ScamAlert {
  speaker: string; // WHO committed the fraud
  callerMessage: string;
  summary: string;
  scamProbability: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  concerns: string[];
  reasoning: string;
  recommendedAction: string;
  timestamp: string;
  kbEnhanced: boolean;
  kbMatches: number;
  confidence: string;
  isAboutMe: boolean; // Is this alert about my own message?
}

export default function VoiceCall() {
  const [roomId, setRoomId] = useState("");
  const [isInCall, setIsInCall] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<
    "unknown" | "granted" | "denied" | "prompt"
  >("unknown");
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<string>("Disconnected");
  
  // Role and scam detection states
  const [userRole, setUserRole] = useState<"user" | "caller" | null>(null);
  const [isProtected, setIsProtected] = useState(false);
  const [currentScamAlert, setCurrentScamAlert] = useState<ScamAlert | null>(null);
  const [scamHistory, setScamHistory] = useState<ScamAlert[]>([]);
  const [showScamAlert, setShowScamAlert] = useState(false);
  const [showDangerBanner, setShowDangerBanner] = useState(false);
  const [alertCount, setAlertCount] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const localAudioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const alertAudioRef = useRef<HTMLAudioElement | null>(null);

  const isInCallRef = useRef(false);
  const isMutedRef = useRef(false);
  const roomIdRef = useRef("");

  const iceServers: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  useEffect(() => {
    isInCallRef.current = isInCall;
  }, [isInCall]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    const checkInitialPermissions = async () => {
      try {
        const permission = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        setPermissionStatus(permission.state as "granted" | "denied" | "prompt");

        permission.onchange = () => {
          setPermissionStatus(permission.state as "granted" | "denied" | "prompt");
        };
      } catch (err) {
        console.log("Permissions API not supported");
        setPermissionStatus("unknown");
      }
    }; 

    checkInitialPermissions();
    updateAvailableDevices();

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
    console.log("🔌 Connecting to:", backendUrl);

    socketRef.current = io(backendUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current.on("connect", () => {
      console.log("✅ Socket connected:", socketRef.current?.id);
      setConnectionStatus("Connected");
    });

    socketRef.current.on("disconnect", () => {
      console.log("❌ Socket disconnected");
      setConnectionStatus("Disconnected");
    });

    // Listen for role assignment
    socketRef.current.on("role-assigned", (data: { role: "user" | "caller"; socketId: string; isProtected: boolean }) => {
      console.log("👤 Role assigned:", data.role);
      setUserRole(data.role);
      setIsProtected(data.isProtected);
      
      if (data.isProtected) {
        console.log("🛡️ You are being protected from scams");
      } else {
        console.log("📞 You are the caller");
      }
    });

    // 🚨 CRITICAL: Listen for fraud scores (EVERYONE in room receives this)
    socketRef.current.on("fraud-score", (data: {
      speaker: string;
      message: string;
      summary: string;
      fraudScore: number;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      redFlags: string[];
      reasoning: string;
      matchedPatterns: string[];
      kbEnhanced: boolean;
      kbMatches: number;
      confidence: { final: number; base: number; kbBoost: number; explanation: string };
      timestamp: string;
    }) => {
      console.log("📊 FRAUD SCORE RECEIVED:", data);
      console.log("   Speaker who was analyzed:", data.speaker);
      console.log("   My socket ID:", socketRef.current?.id);
      console.log("   Fraud Score:", data.fraudScore, "Risk Level:", data.riskLevel);
      
      // Check if this is about someone else (not me)
      const isAboutSomeoneElse = data.speaker !== socketRef.current?.id;
      
      if (isAboutSomeoneElse) {
        console.log("⚠️ FRAUD ANALYSIS: Another user's message was analyzed");
      } else {
        console.log("ℹ️ This is analysis of my own message");
      }
      
      // ⚠️ ONLY SHOW ALARMS FOR HIGH RISK (>85%) FROM OTHER USERS
      if (isAboutSomeoneElse && data.riskLevel === "HIGH" && data.fraudScore > 85) {
        console.log("🚨 HIGH RISK FRAUD DETECTED (>85%) - TRIGGERING FULL ALERT");
        
        // Create fraud alert
        const alert: ScamAlert = {
          speaker: data.speaker,
          callerMessage: data.message,
          summary: data.summary,
          scamProbability: data.fraudScore,
          riskLevel: data.riskLevel,
          concerns: data.redFlags,
          reasoning: data.reasoning,
          recommendedAction: getFraudRecommendation(data.riskLevel, data.matchedPatterns),
          timestamp: data.timestamp,
          kbEnhanced: data.kbEnhanced,
          kbMatches: data.kbMatches,
          confidence: data.confidence.explanation,
          isAboutMe: !isAboutSomeoneElse,
        };
        
        setCurrentScamAlert(alert);
        setScamHistory(prev => [alert, ...prev]);
        setShowScamAlert(true);
        setAlertCount(prev => prev + 1);
        setShowDangerBanner(true);
        
        // Play continuous alert sound
        playAlertSound(true);
        
        // Vibrate in SOS pattern
        if (navigator.vibrate) {
          navigator.vibrate([
            200, 100, 200, 100, 200, 300,  // ... (short)
            500, 100, 500, 100, 500, 300,  // --- (long)
            200, 100, 200, 100, 200         // ... (short)
          ]);
        }
        
        // Change page title to alert
        document.title = "🚨 SCAM ALERT! 🚨";
        
        // Flash the favicon
        flashFavicon();
        
        // Show browser notification
        showNotification(
          "🚨 SCAM ALERT!", 
          `High fraud risk detected from other user!\nFraud Score: ${data.fraudScore}%\n${data.summary}`
        );
      } else if (isAboutSomeoneElse && data.riskLevel === "HIGH" && data.fraudScore <= 85) {
        // Log HIGH risk but below threshold - no alarm
        console.log(`⚠️ HIGH risk detected (${data.fraudScore}%) but below 85% threshold - no alarm triggered`);
      } else if (isAboutSomeoneElse && (data.riskLevel === "MEDIUM" || data.riskLevel === "LOW")) {
        // Log MEDIUM/LOW risk - no alarm
        console.log(`ℹ️ ${data.riskLevel} risk detected (${data.fraudScore}%) - no alarm triggered`);
      } else if (!isAboutSomeoneElse) {
        // My own message was flagged - just log it
        console.log(`ℹ️ Your message fraud score: ${data.fraudScore}% (${data.riskLevel})`);
      }
      
      // Log KB enhancement details
      if (data.kbEnhanced) {
        console.log(`✅ KB Enhanced: ${data.kbMatches} patterns matched`);
        console.log(`   ${data.confidence.explanation}`);
      }
    });

    // Listen for conversation reset notifications
    socketRef.current.on("conversation-reset-notification", (data: {
      userId: string;
      resetBy: string;
      timestamp: string;
    }) => {
      console.log("🔄 Conversation reset notification:", data);
      if (data.userId === socketRef.current?.id) {
        console.log("✅ Your conversation history has been reset");
      }
    });

    socketRef.current.on("reset-conversation-success", (data: any) => {
      console.log("✅ Reset conversation successful:", data);
    });

    socketRef.current.on("reset-conversation-error", (data: { message: string }) => {
      console.error("❌ Reset conversation error:", data.message);
      alert(`Failed to reset conversation: ${data.message}`);
    });

    socketRef.current.on("existing-users", async (users: any[]) => {
      console.log("👥 Existing users in room:", users);
      setTimeout(async () => {
        for (const user of users) {
          const userId = typeof user === 'string' ? user : user.socketId;
          await createOffer(userId);
        }
      }, 500);
    });

    socketRef.current.on("user-joined", async (data: any) => {
      const userId = typeof data === 'string' ? data : data.socketId;
      const role = typeof data === 'object' ? data.role : undefined;
      console.log("🆕 New user joined:", userId, "Role:", role);
    });

    socketRef.current.on("offer", async (data: { offer: RTCSessionDescriptionInit; from: string }) => {
      console.log("📥 Received offer from:", data.from);
      await handleOffer(data.offer, data.from);
    });

    socketRef.current.on("answer", async (data: { answer: RTCSessionDescriptionInit; from: string }) => {
      console.log("📥 Received answer from:", data.from);
      await handleAnswer(data.answer, data.from);
    });

    socketRef.current.on("ice-candidate", async (data: { candidate: RTCIceCandidateInit; from: string }) => {
      console.log("🧊 Received ICE candidate from:", data.from);
      await handleIceCandidate(data.candidate, data.from);
    });

    socketRef.current.on("transcript", (data: { text: string; speaker: string; speakerRole?: string; timestamp: string }) => {
      console.log("📝 Received transcript:", data);
      // Don't display transcripts in UI - only log to console
    });

    socketRef.current.on("user-left", (userId: string) => {
      console.log("👋 User left:", userId);
      const pc = peerConnectionsRef.current.get(userId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(userId);
      }
    });

    return () => {
      cleanup();
    };
  }, []);

  const cleanup = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    stopAudioStreaming();
    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();
    if (alertAudioRef.current) {
      alertAudioRef.current.pause();
    }
    document.title = "Voice Call";
  };

  const updateAvailableDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((device) => device.kind === "audioinput");
      setAvailableDevices(audioDevices);
      console.log("🎤 Available audio devices:", audioDevices.length);
    } catch (err) {
      console.error("Error enumerating devices:", err);
    }
  };

  const testMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("🎤 Microphone test started");

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      microphone.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkAudio = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        console.log("🔊 Audio level:", average);
      };

      const interval = setInterval(checkAudio, 100);

      setTimeout(() => {
        clearInterval(interval);
        stream.getTracks().forEach((track) => track.stop());
        audioContext.close();
        alert("✅ Microphone test successful! Check console for audio levels.");
      }, 2000);

      alert("🎤 Testing microphone for 2 seconds... Speak now! Check console for audio levels.");
    } catch (err) {
      console.error("Microphone test failed:", err);
      alert("❌ Microphone test failed. Please check your microphone connection.");
    }
  };

  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      alert("✅ Microphone permission granted! You can now start your call.");
      setPermissionStatus("granted");
      await updateAvailableDevices();
    } catch (err) {
      console.error("Permission request failed:", err);
      if (err instanceof DOMException) {
        switch (err.name) {
          case "NotAllowedError":
            alert("❌ Permission denied. Please manually enable microphone access in your browser settings.");
            setPermissionStatus("denied");
            break;
          case "NotFoundError":
            alert("❌ No microphone found. Please connect a microphone and try again.");
            break;
          default:
            alert(`❌ Error: ${err.message}`);
        }
      }
    }
  };

  const startCall = async () => {
    if (!roomId.trim()) {
      alert("Please enter a room ID");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Your browser does not support microphone access. Please use a modern browser like Chrome, Firefox, or Safari.");
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((device) => device.kind === "audioinput");

      if (audioDevices.length === 0) {
        alert("No microphone found. Please connect a microphone and try again.");
        return;
      }

      console.log("🎤 Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });

      console.log("✅ Microphone access granted");
      localStreamRef.current = stream;

      if (localAudioRef.current) {
        localAudioRef.current.srcObject = stream;
        localAudioRef.current.muted = true;
      }

      console.log("📞 Joining room:", roomId);
      socketRef.current?.emit("join-room", { roomId });
      setIsInCall(true);
      setIsMuted(false);

      // Request notification permission
      requestNotificationPermission();

      setTimeout(() => {
        startAudioStreaming(stream);
      }, 500);
    } catch (err) {
      console.error("Error accessing microphone:", err);

      if (err instanceof DOMException) {
        switch (err.name) {
          case "NotAllowedError":
            alert('❌ Microphone access denied!\n\nTo fix this:\n1. Look for the microphone 🎤 icon in your browser\'s address bar\n2. Click it and select "Allow"\n3. Refresh the page and try again');
            break;
          case "NotFoundError":
            alert("❌ Microphone not found! Please connect a microphone and try again.");
            break;
          case "NotReadableError":
            alert("Microphone is already in use by another application. Please close other apps using the microphone.");
            break;
          default:
            alert(`Microphone error: ${err.message}`);
        }
      }
    }
  };

  const startAudioStreaming = (stream: MediaStream) => {
    try {
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      processorNodeRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      processorNodeRef.current.onaudioprocess = (e) => {
        if (!isMutedRef.current && socketRef.current?.connected) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = convertFloat32ToInt16(inputData);
          
          socketRef.current.emit("audio-stream", {
            audio: pcmData.buffer,
            roomId: roomIdRef.current,
          });
        }
      };

      source.connect(processorNodeRef.current);
      processorNodeRef.current.connect(audioContextRef.current.destination);

      setIsRecording(true);
      console.log("🎙️ Audio streaming started");
    } catch (err) {
      console.error("Error starting audio streaming:", err);
    }
  };

  const convertFloat32ToInt16 = (float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  };

  const stopAudioStreaming = () => {
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    setIsRecording(false);
    console.log("⏹️ Audio streaming stopped");
  };

  const createPeerConnection = (userId: string) => {
    console.log("🔗 Creating peer connection for:", userId);
    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit("ice-candidate", {
          candidate: event.candidate,
          to: userId,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log("🎵 Received remote track from:", userId);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        remoteAudioRef.current.muted = false;
        remoteAudioRef.current.play().catch((err) => console.error("❌ Remote audio play failed:", err));
      }
    };

    pc.oniceconnectionstatechange = () => {
      setConnectionStatus(`ICE: ${pc.iceConnectionState}`);
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        if (localStreamRef.current) {
          pc.addTrack(track, localStreamRef.current);
        }
      });
    }

    peerConnectionsRef.current.set(userId, pc);
    return pc;
  };

  const createOffer = async (userId: string) => {
    try {
      if (!localStreamRef.current) return;

      const pc = createPeerConnection(userId);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      socketRef.current?.emit("offer", { offer, to: userId });
    } catch (err) {
      console.error("❌ Error creating offer:", err);
    }
  };

  const handleOffer = async (offer: RTCSessionDescriptionInit, from: string) => {
    try {
      if (!localStreamRef.current) return;

      let pc = peerConnectionsRef.current.get(from);
      if (!pc) {
        pc = createPeerConnection(from);
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      const pending = pendingCandidatesRef.current.get(from) || [];
      for (const candidate of pending) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current.delete(from);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit("answer", { answer, to: from });
    } catch (err) {
      console.error("❌ Error handling offer:", err);
    }
  };

  const handleAnswer = async (answer: RTCSessionDescriptionInit, from: string) => {
    try {
      const pc = peerConnectionsRef.current.get(from);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));

        const pending = pendingCandidatesRef.current.get(from) || [];
        for (const candidate of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current.delete(from);
      }
    } catch (err) {
      console.error("❌ Error handling answer:", err);
    }
  };

  const handleIceCandidate = async (candidate: RTCIceCandidateInit, from: string) => {
    try {
      const pc = peerConnectionsRef.current.get(from);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        if (!pendingCandidatesRef.current.has(from)) {
          pendingCandidatesRef.current.set(from, []);
        }
        pendingCandidatesRef.current.get(from)?.push(candidate);
      }
    } catch (err) {
      console.error("❌ Error adding ICE candidate:", err);
    }
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        const newMutedState = !isMuted;
        audioTrack.enabled = !newMutedState;
        setIsMuted(newMutedState);
        isMutedRef.current = newMutedState;
        console.log(newMutedState ? "🔇 Muted" : "🔊 Unmuted");
      }
    }
  };

  const endCall = () => {
    console.log("📞 Ending call");

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();

    stopAudioStreaming();

    if (alertAudioRef.current) {
      alertAudioRef.current.pause();
    }

    document.title = "Voice Call";

    setIsInCall(false);
    setIsRecording(false);
    setIsMuted(false);
    setTranscripts([]);
    setConnectionStatus("Disconnected");
    setUserRole(null);
    setIsProtected(false);
    setCurrentScamAlert(null);
    setShowScamAlert(false);
    setShowDangerBanner(false);
    setAlertCount(0);
    setScamHistory([]);
  };

  const playAlertSound = (continuous: boolean = false) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // High-pitched alarm sound
    oscillator.frequency.value = 1200;
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
    
    if (continuous) {
      // Create repeating alarm pattern
      let time = audioContext.currentTime;
      for (let i = 0; i < 6; i++) {
        oscillator.frequency.setValueAtTime(1200, time);
        oscillator.frequency.setValueAtTime(800, time + 0.2);
        time += 0.4;
      }
      gainNode.gain.exponentialRampToValueAtTime(0.01, time);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(time);
    } else {
      // Single beep
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    }
  };

  const flashFavicon = () => {
    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (link) {
      const originalHref = link.href;
      let count = 0;
      const interval = setInterval(() => {
        link.href = count % 2 === 0 ? 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚨</text></svg>' : originalHref;
        count++;
        if (count > 10) {
          clearInterval(interval);
          link.href = originalHref;
        }
      }, 500);
    }
  };

  const requestNotificationPermission = async () => {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  };

  const showNotification = (title: string, body: string) => {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, {
        body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚨</text></svg>",
        badge: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚨</text></svg>",
        requireInteraction: true,
      });
    }
  };

  const getFraudRecommendation = (riskLevel: string, patterns: string[]): string => {
    if (riskLevel === "HIGH") {
      return "🚨 HIGH RISK DETECTED - END THIS CALL IMMEDIATELY! This appears to be a scam. Hang up and verify through official channels.";
    } else if (riskLevel === "MEDIUM") {
      return "⚠️ Be extremely cautious. Do not share personal information, money, or account details. Verify the caller's identity independently.";
    } else {
      return "ℹ️ Conversation appears normal. Continue monitoring.";
    }
  };

  const dismissScamAlert = () => {
    setShowScamAlert(false);
    setShowDangerBanner(false);
    setCurrentScamAlert(null);
    setAlertCount(0);
    setScamHistory([]);
    
    if (alertAudioRef.current) {
      alertAudioRef.current.pause();
    }
    
    // Reset page title and favicon
    document.title = "Voice Call";
    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (link && link.href.includes('data:image')) {
      // Reset to default if it's currently the alert icon
      link.href = "/favicon.ico";
    }
    
    // Reset conversation when dismissing the alarm
    if (currentScamAlert) {
      resetConversationForSuspiciousUser();
    }
    
    console.log("✅ UI cleared - all alerts and history dismissed");
  };

  const dismissDangerBanner = () => {
    setShowDangerBanner(false);
  };

  // NEW: Reset conversation for the suspicious user
  const resetConversationForSuspiciousUser = () => {
    if (!socketRef.current || !currentScamAlert) {
      console.error("❌ Cannot reset: No socket or alert");
      return;
    }

    console.log("🔄 Requesting conversation reset for user:", currentScamAlert.speaker);
    
    socketRef.current.emit("reset-conversation", {
      roomId: roomId,
      targetUserId: currentScamAlert.speaker, // Reset the suspicious user's conversation
    });
  };

  const getRiskColor = (level: string) => {
    switch (level) {
      case "HIGH": return "#dc3545";
      case "MEDIUM": return "#ffc107";
      case "LOW": return "#28a745";
      default: return "#6c757d";
    }
  };

  return (
    <div style={{ padding: "40px", fontFamily: "Arial, sans-serif", maxWidth: "800px", margin: "0 auto", position: "relative" }}>
      {/* Persistent Danger Banner - Only show for HIGH RISK >85% about OTHER users */}
      {showDangerBanner && currentScamAlert && !currentScamAlert.isAboutMe && currentScamAlert.riskLevel === "HIGH" && currentScamAlert.scamProbability > 85 && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          background: "#dc3545",
          color: "white",
          padding: "20px",
          zIndex: 999,
          animation: "slideDown 0.5s ease-out, pulse 2s infinite",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          borderBottom: "4px solid #a02030",
        }}>
          <div style={{ maxWidth: "800px", margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "24px", fontWeight: "bold", marginBottom: "8px" }}>
                🚨 DANGER - HIGH RISK SCAM DETECTED 🚨
              </div>
              <div style={{ fontSize: "18px", fontWeight: "bold" }}>
                Fraud Risk: {currentScamAlert.scamProbability}% 
                {currentScamAlert.kbEnhanced && ` (KB Enhanced: ${currentScamAlert.kbMatches} patterns)`}
              </div>
              <div style={{ fontSize: "14px", marginTop: "5px" }}>
                Consider ending this call immediately!
              </div>
            </div>
            <button
              onClick={dismissDangerBanner}
              style={{
                background: "rgba(255,255,255,0.3)",
                border: "2px solid white",
                color: "white",
                padding: "8px 16px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "bold",
                marginLeft: "20px",
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: showDangerBanner ? "120px" : "0" }}>
        <h1 style={{ marginBottom: "30px" }}>🛡️ Protected Voice Call with Fraud Detection</h1>

        {/* Alert Counter - Only count HIGH RISK >85% alerts about OTHER users */}
        {alertCount > 0 && (
          <div style={{
            padding: "10px",
            background: "#dc3545",
            color: "white",
            borderRadius: "8px",
            marginBottom: "15px",
            textAlign: "center",
            fontWeight: "bold",
            animation: "pulse 1.5s infinite",
          }}>
            {alertCount === 1 && "🚨 HIGH RISK Fraud Alert Detected (>85%)"}
            {alertCount > 1 && `🚨 ${alertCount} HIGH RISK Fraud Alerts Detected (>85%) - Be Very Careful!`}
          </div>
        )}

        {/* Role indicator */}
        {isInCall && userRole && (
          <div style={{ 
            padding: "15px", 
            background: isProtected ? "#d4edda" : "#d1ecf1", 
            borderRadius: "8px", 
            marginBottom: "20px",
            border: `2px solid ${isProtected ? "#28a745" : "#17a2b8"}`
          }}>
            <strong>Your Role:</strong> {isProtected ? "🛡️ Protected User" : "📞 Caller"}
            {isProtected && <div style={{ marginTop: "5px", fontSize: "14px" }}>You are being protected from potential scams (Only HIGH risk &gt;85% will trigger alerts)</div>}
          </div>
        )}

        {/* Scam Alert Modal - Only show for HIGH RISK >85% about OTHER users */}
        {showScamAlert && currentScamAlert && !currentScamAlert.isAboutMe && currentScamAlert.riskLevel === "HIGH" && currentScamAlert.scamProbability > 85 && (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}>
            <div style={{
              background: "white",
              padding: "40px",
              borderRadius: "16px",
              maxWidth: "600px",
              maxHeight: "90vh",
              overflow: "auto",
              border: "6px solid #dc3545",
              animation: "shake 0.5s, pulse 2s infinite",
              boxShadow: "0 0 40px #dc3545",
            }}>
              <h2 style={{ 
                color: "#dc3545",
                marginBottom: "20px",
                fontSize: "32px",
                textAlign: "center",
              }}>
                🚨 HIGH RISK SCAM ALERT! 🚨
              </h2>
              
              <div style={{ 
                marginBottom: "15px",
                background: "#f8f9fa",
                padding: "15px",
                borderRadius: "8px",
                borderLeft: "4px solid #007bff",
              }}>
                <strong>⚠️ Another user may be attempting fraud</strong>
                <div style={{ fontSize: "14px", marginTop: "5px", color: "#666" }}>
                  Speaker ID: {currentScamAlert.speaker}
                </div>
              </div>
              
              <div style={{ 
                marginBottom: "25px",
                background: "#dc3545",
                color: "white",
                padding: "20px",
                borderRadius: "12px",
              }}>
                <strong style={{ fontSize: "18px" }}>Fraud Risk Score:</strong>
                <div style={{
                  fontSize: "48px",
                  fontWeight: "bold",
                  margin: "10px 0",
                  textAlign: "center",
                }}>
                  {currentScamAlert.scamProbability}%
                </div>
                <div style={{ fontSize: "16px", textAlign: "center" }}>
                  HIGH RISK (Above 85% threshold)
                </div>
                {currentScamAlert.kbEnhanced && (
                  <div style={{ fontSize: "14px", textAlign: "center", marginTop: "8px" }}>
                    ✓ Enhanced by Knowledge Base ({currentScamAlert.kbMatches} patterns)
                  </div>
                )}
              </div>

              <div style={{ marginBottom: "20px", fontSize: "16px" }}>
                <strong style={{ fontSize: "18px" }}>Message from other user:</strong>
                <p style={{ 
                  marginTop: "8px", 
                  lineHeight: "1.6",
                  background: "#f8f9fa",
                  padding: "10px",
                  borderRadius: "4px",
                  fontStyle: "italic",
                }}>
                  "{currentScamAlert.callerMessage}"
                </p>
              </div>

              <div style={{ marginBottom: "20px", fontSize: "16px" }}>
                <strong style={{ fontSize: "18px" }}>Analysis:</strong>
                <p style={{ marginTop: "8px", lineHeight: "1.6" }}>{currentScamAlert.summary}</p>
              </div>

              {currentScamAlert.concerns.length > 0 && (
                <div style={{ 
                  marginBottom: "20px",
                  background: "#fff3cd",
                  padding: "15px",
                  borderRadius: "8px",
                  border: "2px solid #ffc107",
                }}>
                  <strong style={{ fontSize: "18px" }}>🚩 Red Flags Detected:</strong>
                  <ul style={{ marginTop: "10px", paddingLeft: "20px", lineHeight: "1.8" }}>
                    {currentScamAlert.concerns.map((concern, i) => (
                      <li key={i} style={{ fontSize: "15px", marginBottom: "8px" }}>{concern}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ 
                marginTop: "25px", 
                padding: "20px", 
                background: "#dc3545",
                color: "white",
                borderRadius: "12px",
                border: "3px solid #a02030",
              }}>
                <strong style={{ fontSize: "18px" }}>📋 RECOMMENDED ACTION:</strong>
                <p style={{ marginTop: "10px", fontSize: "16px", fontWeight: "bold", lineHeight: "1.6" }}>
                  {currentScamAlert.recommendedAction}
                </p>
              </div>

              <div style={{ display: "flex", gap: "10px", marginTop: "25px" }}>
                <button
                  onClick={endCall}
                  style={{
                    flex: 1,
                    padding: "16px",
                    fontSize: "18px",
                    fontWeight: "bold",
                    backgroundColor: "#dc3545",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    cursor: "pointer",
                    animation: "pulse 1.5s infinite",
                  }}
                >
                  🚨 END CALL NOW
                </button>
                <button
                  onClick={dismissScamAlert}
                  style={{
                    flex: 1,
                    padding: "16px",
                    fontSize: "16px",
                    backgroundColor: "#6c757d",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    cursor: "pointer",
                  }}
                >
                  Dismiss & Reset
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: "10px", background: "#f0f0f0", borderRadius: "4px", marginBottom: "20px", fontSize: "14px" }}>
          <strong>Connection Status:</strong> {connectionStatus}
          {socketRef.current && <span> | Socket ID: {socketRef.current.id}</span>}
          {isRecording && <span> | 🎤 Recording</span>}
          {isMuted && <span> | 🔇 Muted</span>}
        </div>

        {!isInCall ? (
          <div style={{ marginBottom: "30px" }}>
            <input
              type="text"
              placeholder="Enter Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              style={{ padding: "12px", fontSize: "16px", width: "300px", marginRight: "10px", border: "2px solid #ddd", borderRadius: "4px" }}
            />
            <button
              onClick={startCall}
              style={{ padding: "12px 24px", fontSize: "16px", backgroundColor: "#4CAF50", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
            >
              Start Call
            </button>

            <PermissionStatus
              status={permissionStatus}
              onRequestPermission={requestMicrophonePermission}
              onTestMicrophone={testMicrophone}
              devices={availableDevices}
            />
          </div>
        ) : (
          <CallControls roomId={roomId} isMuted={isMuted} isRecording={isRecording} onToggleMute={toggleMute} onEndCall={endCall} />
        )}

        <audio ref={localAudioRef} autoPlay muted playsInline />
        <audio ref={remoteAudioRef} autoPlay playsInline />

        {/* Removed TranscriptDisplay component - transcripts only logged to console */}
        
        {/* Removed Scam History section - only HIGH RISK >85% alerts shown in modal */}

        <Instructions />
        
        <style jsx>{`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-10px); }
            75% { transform: translateX(10px); }
          }
          
          @keyframes pulse {
            0%, 100% { 
              transform: scale(1);
              box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7);
            }
            50% { 
              transform: scale(1.05);
              box-shadow: 0 0 0 20px rgba(220, 53, 69, 0);
            }
          }
          
          @keyframes flashBorder {
            0%, 100% { border-color: #dc3545; }
            50% { border-color: #ff6b6b; }
          }
          
          @keyframes slideDown {
            from {
              transform: translateY(-100%);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
        `}</style>
      </div>
    </div>
  );
}