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
  const [dismissedUsers, setDismissedUsers] = useState<Map<string, number>>(new Map());

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
      
      // ⚠️ ONLY SHOW ALARMS FOR HIGH RISK (>80%) FROM OTHER USERS
      if (isAboutSomeoneElse && data.riskLevel === "HIGH" && data.fraudScore > 80) {
        // 🔒 CHECK COOLDOWN: If this user was recently dismissed, ignore for 7 seconds
        const now = Date.now();
        const lastDismissed = dismissedUsers.get(data.speaker);
        
        if (lastDismissed && (now - lastDismissed) < 7000) {
          const remainingSeconds = Math.ceil((7000 - (now - lastDismissed)) / 1000);
          console.log(`⏳ COOLDOWN ACTIVE: Ignoring alarm for user ${data.speaker} (${remainingSeconds}s remaining)`);
          console.log(`   Fraud Score: ${data.fraudScore}% - Would trigger alarm but in cooldown period`);
          return; // Exit without showing alarm
        }
        
        console.log("🚨 HIGH RISK FRAUD DETECTED (>80%) - TRIGGERING FULL ALERT");
        
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
      } else if (isAboutSomeoneElse && data.riskLevel === "HIGH" && data.fraudScore <= 80) {
        // Log HIGH risk but below threshold - no alarm
        console.log(`⚠️ HIGH risk detected (${data.fraudScore}%) but below 80% threshold - no alarm triggered`);
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
    setDismissedUsers(new Map()); // Clear cooldown map
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
    // Record the dismiss timestamp for this user (7-second cooldown)
    if (currentScamAlert) {
      const updatedDismissedUsers = new Map(dismissedUsers);
      updatedDismissedUsers.set(currentScamAlert.speaker, Date.now());
      setDismissedUsers(updatedDismissedUsers);
      
      console.log(`⏳ COOLDOWN STARTED: User ${currentScamAlert.speaker} alarms suppressed for 7 seconds`);
      
      // Auto-remove from cooldown after 7 seconds
      setTimeout(() => {
        setDismissedUsers(prev => {
          const updated = new Map(prev);
          updated.delete(currentScamAlert.speaker);
          return updated;
        });
      }, 7000);
    }
    
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
  <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8 px-4 font-sans">
    <div className="max-w-4xl mx-auto relative">
      {/* Persistent Danger Banner - Only show for HIGH RISK >80% about OTHER users */}
      {showDangerBanner && currentScamAlert && !currentScamAlert.isAboutMe && currentScamAlert.riskLevel === "HIGH" && currentScamAlert.scamProbability > 0 && (
        <div className="fixed top-0 left-0 right-0 bg-gradient-to-r from-red-600 to-red-700 text-white shadow-2xl z-50 animate-in slide-in-from-top duration-500 border-b-4 border-red-900">
          <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-3xl animate-pulse">🚨</span>
                <h2 className="text-2xl font-bold tracking-tight">DANGER - HIGH RISK SCAM DETECTED</h2>
                <span className="text-3xl animate-pulse">🚨</span>
              </div>
              <div className="flex items-center gap-4 text-lg">
                <span className="font-semibold">Fraud Risk: {currentScamAlert.scamProbability}%</span>
                {currentScamAlert.kbEnhanced && (
                  <span className="bg-red-800 px-3 py-1 rounded-full text-sm font-medium">
                    KB Enhanced: {currentScamAlert.kbMatches} patterns
                  </span>
                )}
              </div>
              <p className="text-sm font-medium opacity-90">Consider ending this call immediately!</p>
            </div>
            <button
              onClick={dismissDangerBanner}
              className="ml-6 bg-white/20 hover:bg-white/30 border-2 border-white rounded-lg px-4 py-2 font-bold transition-all duration-200 hover:scale-105"
              aria-label="Dismiss banner"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className={showDangerBanner ? "mt-32" : ""}>
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6 border border-gray-200 text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <span className="text-4xl">🛡️</span>
            <h1 className="text-3xl font-bold text-gray-900 text-center">Protected Voice Call</h1>
          </div>
          <p className="text-gray-600 ml-14">Real-time fraud detection and monitoring</p>
        </div>

        {/* Alert Counter - Only count HIGH RISK >80% alerts about OTHER users */}
        {alertCount > 0 && (
          <div className="bg-gradient-to-r from-red-500 to-red-600 text-white rounded-xl shadow-lg p-5 mb-6 animate-pulse">
            <div className="flex items-center justify-center gap-3">
              <span className="text-3xl">🚨</span>
              <p className="text-xl font-bold">
                {alertCount === 1 
                  ? "HIGH RISK Fraud Alert Detected (>80%)" 
                  : `${alertCount} HIGH RISK Fraud Alerts Detected (>80%) - Be Very Careful!`}
              </p>
              <span className="text-3xl">🚨</span>
            </div>
          </div>
        )}

        {/* Role indicator */}
        {isInCall && userRole && (
          <div className={`rounded-xl shadow-md p-5 mb-6 border-2 ${
            isProtected 
              ? "bg-green-50 border-green-500" 
              : "bg-blue-50 border-blue-500"
          }`}>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">{isProtected ? "🛡️" : "📞"}</span>
              <h3 className="text-lg font-bold text-gray-900">
                Your Role: {isProtected ? "Protected User" : "Caller"}
              </h3>
            </div>
            {isProtected && (
              <p className="text-sm text-gray-700 ml-9">
                You are being protected from potential scams (Only HIGH risk &gt;80% will trigger alerts)
              </p>
            )}
          </div>
        )}

        {/* Scam Alert Modal - Only show for HIGH RISK >80% about OTHER users */}
        {showScamAlert && currentScamAlert && !currentScamAlert.isAboutMe && currentScamAlert.riskLevel === "HIGH" && currentScamAlert.scamProbability > 80 && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-300">
            <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border-4 border-red-600 shadow-2xl animate-in zoom-in-95 duration-300">
              <div className="sticky top-0 bg-gradient-to-r from-red-600 to-red-700 text-white p-6 rounded-t-xl">
                <h2 className="text-3xl font-bold text-center flex items-center justify-center gap-3">
                  <span className="text-4xl animate-pulse">🚨</span>
                  HIGH RISK SCAM ALERT!
                  <span className="text-4xl animate-pulse">🚨</span>
                </h2>
              </div>

              <div className="p-8 space-y-6">
                {/* Speaker Warning */}
                <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-lg">
                  <p className="font-semibold text-gray-900 mb-1">⚠️ Another user may be attempting fraud</p>
                  <p className="text-sm text-gray-600">Speaker ID: {currentScamAlert.speaker}</p>
                </div>

                {/* Fraud Risk Score */}
                <div className="bg-gradient-to-br from-red-600 to-red-700 text-white rounded-xl p-6 shadow-lg">
                  <p className="text-lg font-semibold mb-3">Fraud Risk Score:</p>
                  <div className="text-center">
                    <div className="text-6xl font-bold mb-2">{currentScamAlert.scamProbability}%</div>
                    <div className="text-xl font-medium mb-2">HIGH RISK (Above 80% threshold)</div>
                    {currentScamAlert.kbEnhanced && (
                      <div className="bg-red-800 inline-block px-4 py-2 rounded-full text-sm font-medium mt-2">
                        ✓ Enhanced by Knowledge Base ({currentScamAlert.kbMatches} patterns)
                      </div>
                    )}
                  </div>
                </div>

                {/* Message */}
                <div>
                  <h3 className="text-lg font-bold text-gray-900 mb-3">Message from other user:</h3>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <p className="text-gray-800 italic leading-relaxed">"{currentScamAlert.callerMessage}"</p>
                  </div>
                </div>

                {/* Analysis */}
                <div>
                  <h3 className="text-lg font-bold text-gray-900 mb-3">Analysis:</h3>
                  <p className="text-gray-700 leading-relaxed">{currentScamAlert.summary}</p>
                </div>

                {/* Red Flags */}
                {currentScamAlert.concerns.length > 0 && (
                  <div className="bg-yellow-50 border-2 border-yellow-400 rounded-xl p-5">
                    <h3 className="text-lg font-bold text-gray-900 mb-3 flex items-center gap-2">
                      <span className="text-2xl">🚩</span>
                      Red Flags Detected:
                    </h3>
                    <ul className="space-y-2">
                      {currentScamAlert.concerns.map((concern, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <span className="text-yellow-600 font-bold mt-1">•</span>
                          <span className="text-gray-800">{concern}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Recommended Action */}
                <div className="bg-gradient-to-br from-red-600 to-red-700 text-white rounded-xl p-6 border-2 border-red-900 shadow-lg">
                  <h3 className="text-lg font-bold mb-3 flex items-center gap-2">
                    <span className="text-xl">📋</span>
                    RECOMMENDED ACTION:
                  </h3>
                  <p className="text-base font-semibold leading-relaxed">
                    {currentScamAlert.recommendedAction}
                  </p>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-4 pt-4">
                  <button
                    onClick={endCall}
                    className="flex-1 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-bold py-4 px-6 rounded-xl shadow-lg transition-all duration-200 hover:scale-105 text-lg animate-pulse"
                  >
                    🚨 END CALL NOW
                  </button>
                  <button
                    onClick={dismissScamAlert}
                    className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-semibold py-4 px-6 rounded-xl shadow-lg transition-all duration-200 hover:scale-105"
                  >
                    Dismiss & Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Connection Status */}
        <div className="bg-white rounded-xl shadow-md p-5 mb-6 border border-gray-200">
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              <span className="font-semibold">Connection Status:</span>
              <span className="text-gray-900">{connectionStatus}</span>
            </div>
            {socketRef.current && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">|</span>
                <span className="font-semibold">Socket ID:</span>
                <code className="bg-gray-100 px-2 py-1 rounded text-xs">{socketRef.current.id}</code>
              </div>
            )}
            {isRecording && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">|</span>
                <span className="text-red-600 font-semibold animate-pulse">🎤 Recording</span>
              </div>
            )}
            {isMuted && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500">|</span>
                <span className="text-gray-600 font-semibold">🔇 Muted</span>
              </div>
            )}
          </div>
        </div>

        {/* Call Controls */}
        {!isInCall ? (
          <div className="bg-white rounded-xl shadow-md p-8 mb-6 border border-gray-200">
            <h3 className="text-xl font-bold text-gray-900 mb-6">Start a Call</h3>
            <div className="flex flex-wrap gap-4 mb-6">
              <input
                type="text"
                placeholder="Enter Room ID"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="flex-1 min-w-[250px] px-4 py-3 text-base border-2 border-gray-300 rounded-lg focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-200 transition-all"
              />
              <button
                onClick={startCall}
                className="px-8 py-3 bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white font-semibold rounded-lg shadow-lg transition-all duration-200 hover:scale-105 hover:shadow-xl"
              >
                🚀 Start Call
              </button>
            </div>

            <PermissionStatus
              status={permissionStatus}
              onRequestPermission={requestMicrophonePermission}
              onTestMicrophone={testMicrophone}
              devices={availableDevices}
            />
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-md p-8 mb-6 border border-gray-200">
            <CallControls 
              roomId={roomId} 
              isMuted={isMuted} 
              isRecording={isRecording} 
              onToggleMute={toggleMute} 
              onEndCall={endCall} 
            />
          </div>
        )}

        <audio ref={localAudioRef} autoPlay muted playsInline />
        <audio ref={remoteAudioRef} autoPlay playsInline />

        <Instructions />
      </div>
    </div>
    </div>
  )
  }