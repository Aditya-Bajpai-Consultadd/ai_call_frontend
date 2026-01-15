"use client";
import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import PermissionStatus from "./components/PermissionStatus";
import CallControls from "./components/CallControls";
import TranscriptDisplay from "./components/TranscriptDelay";
import Instructions from "./components/Instructions";

interface Transcript {
  text: string;
  speaker: string;
  speakerRole?: string;
  timestamp: string;
}

interface ScamAlert {
  callerMessage: string;
  summary: string;
  scamProbability: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  concerns: string[];
  reasoning: string;
  recommendedAction: string;
  timestamp: string;
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
  
  // NEW: Role and scam detection states
  const [userRole, setUserRole] = useState<"user" | "caller" | null>(null);
  const [isProtected, setIsProtected] = useState(false);
  const [currentScamAlert, setCurrentScamAlert] = useState<ScamAlert | null>(null);
  const [scamHistory, setScamHistory] = useState<ScamAlert[]>([]);
  const [showScamAlert, setShowScamAlert] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const localAudioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

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

    // NEW: Listen for role assignment
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

    // NEW: Listen for scam alerts (only USER receives these)
    socketRef.current.on("scam-alert", (alert: ScamAlert) => {
      console.log("🚨 SCAM ALERT RECEIVED:", alert);
      setCurrentScamAlert(alert);
      setScamHistory(prev => [alert, ...prev]);
      setShowScamAlert(true);
      
      // Play alert sound for high risk
      if (alert.riskLevel === "HIGH") {
        playAlertSound();
        // Optionally vibrate on mobile
        if (navigator.vibrate) {
          navigator.vibrate([200, 100, 200]);
        }
      }
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
      const displayRole = data.speakerRole === "user" ? "You" : "Caller";
      setTranscripts((prev) => [
        ...prev,
        {
          text: data.text,
          speaker: displayRole,
          speakerRole: data.speakerRole,
          timestamp: data.timestamp,
        },
      ]);
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
      // Send room ID without specifying role - server will auto-assign
      socketRef.current?.emit("join-room", { roomId });
      setIsInCall(true);
      setIsMuted(false);

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

    setIsInCall(false);
    setIsRecording(false);
    setIsMuted(false);
    setTranscripts([]);
    setConnectionStatus("Disconnected");
    setUserRole(null);
    setIsProtected(false);
    setCurrentScamAlert(null);
    setShowScamAlert(false);
  };

  const playAlertSound = () => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  };

  const dismissScamAlert = () => {
    setShowScamAlert(false);
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
    <div style={{ padding: "40px", fontFamily: "Arial, sans-serif", maxWidth: "800px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "30px" }}>🛡️ Protected Voice Call with Scam Detection</h1>

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
          {isProtected && <div style={{ marginTop: "5px", fontSize: "14px" }}>You are being protected from potential scams</div>}
        </div>
      )}

      {/* Scam Alert Modal */}
      {showScamAlert && currentScamAlert && isProtected && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000,
        }}>
          <div style={{
            background: "white",
            padding: "30px",
            borderRadius: "12px",
            maxWidth: "500px",
            border: `4px solid ${getRiskColor(currentScamAlert.riskLevel)}`,
            animation: currentScamAlert.riskLevel === "HIGH" ? "shake 0.5s" : "none",
          }}>
            <h2 style={{ 
              color: getRiskColor(currentScamAlert.riskLevel),
              marginBottom: "20px",
              fontSize: "28px"
            }}>
              {currentScamAlert.riskLevel === "HIGH" && "🚨 SCAM ALERT! 🚨"}
              {currentScamAlert.riskLevel === "MEDIUM" && "⚠️ Warning"}
              {currentScamAlert.riskLevel === "LOW" && "ℹ️ Notice"}
            </h2>
            
            <div style={{ marginBottom: "20px" }}>
              <strong>Risk Score:</strong>
              <div style={{
                fontSize: "36px",
                fontWeight: "bold",
                color: getRiskColor(currentScamAlert.riskLevel),
                margin: "10px 0"
              }}>
                {currentScamAlert.scamProbability}%
              </div>
            </div>

            <div style={{ marginBottom: "15px" }}>
              <strong>Summary:</strong>
              <p>{currentScamAlert.summary}</p>
            </div>

            {currentScamAlert.concerns.length > 0 && (
              <div style={{ marginBottom: "15px" }}>
                <strong>⚠️ Red Flags Detected:</strong>
                <ul style={{ marginTop: "5px", paddingLeft: "20px" }}>
                  {currentScamAlert.concerns.map((concern, i) => (
                    <li key={i}>{concern}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ 
              marginTop: "20px", 
              padding: "15px", 
              background: "#fff3cd",
              borderRadius: "8px",
              border: "1px solid #ffc107"
            }}>
              <strong>📋 Recommended Action:</strong>
              <p style={{ marginTop: "5px" }}>{currentScamAlert.recommendedAction}</p>
            </div>

            <button
              onClick={dismissScamAlert}
              style={{
                marginTop: "20px",
                padding: "12px 24px",
                fontSize: "16px",
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                width: "100%"
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div style={{ padding: "10px", background: "#f0f0f0", borderRadius: "4px", marginBottom: "20px", fontSize: "14px" }}>
        <strong>Connection Status:</strong> {connectionStatus}
        {socketRef.current && <span> | Socket ID: {socketRef.current.id}</span>}
        {isRecording && <span> | 🎤 Recording</span>}
        {isMuted && <span> | 🔇 Muted</span>}
        {isProtected && <span> | 🛡️ Protected</span>}
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

      <TranscriptDisplay transcripts={transcripts} />
      
      {/* Scam History */}
      {isProtected && scamHistory.length > 0 && (
        <div style={{ marginTop: "30px" }}>
          <h3>📊 Scam Detection History</h3>
          {scamHistory.slice(0, 5).map((alert, index) => (
            <div key={index} style={{
              padding: "15px",
              margin: "10px 0",
              background: "#f8f9fa",
              borderRadius: "8px",
              borderLeft: `4px solid ${getRiskColor(alert.riskLevel)}`
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
                <strong style={{ color: getRiskColor(alert.riskLevel) }}>
                  {alert.riskLevel} RISK ({alert.scamProbability}%)
                </strong>
                <small>{new Date(alert.timestamp).toLocaleTimeString()}</small>
              </div>
              <div style={{ fontSize: "14px" }}>{alert.summary}</div>
            </div>
          ))}
        </div>
      )}

      <Instructions />
      
      <style jsx>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
      `}</style>
    </div>
  );
}