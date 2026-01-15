function CallControls({ 
  roomId, 
  isMuted, 
  isRecording,
  onToggleMute, 
  onEndCall 
}: {
  roomId: string;
  isMuted: boolean;
  isRecording: boolean;
  onToggleMute: () => void;
  onEndCall: () => void;
}) {
  return (
    <div style={{ marginBottom: '30px' }}>
      <p style={{ fontSize: '18px', marginBottom: '10px' }}>
        📞 In call - Room: <strong>{roomId}</strong>
      </p>
      <p style={{ fontSize: '14px', color: '#666', marginBottom: '15px' }}>
        {isRecording && !isMuted ? '🔴 Recording & Transcribing...' : 'Microphone active'} 
        {isMuted && ' (Muted - Not transcribing)'}
      </p>
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={onToggleMute}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            backgroundColor: isMuted ? '#ff9800' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          {isMuted ? '🔇' : '🎤'} {isMuted ? 'Unmute' : 'Mute'}
        </button>
        <button
          onClick={onEndCall}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            backgroundColor: '#f44336',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          End Call
        </button>
      </div>
    </div>
  );
}

export default CallControls;