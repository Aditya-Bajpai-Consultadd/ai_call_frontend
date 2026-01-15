function Instructions() {
  return (
    <>
      <div style={{ marginTop: '30px', padding: '15px', backgroundColor: '#fff9c4', borderRadius: '8px' }}>
        <h3 style={{ marginTop: 0 }}>Instructions:</h3>
        <ol style={{ marginBottom: 0 }}>
          <li>Enter a room ID (e.g., "room123")</li>
          <li>Click "Start Call" and allow microphone access</li>
          <li>Share the same room ID with another person</li>
          <li>Start speaking to see real-time transcripts</li>
        </ol>
        <p style={{ fontSize: '14px', color: '#666', marginTop: '10px', marginBottom: 0 }}>
          Note: Works best in Chrome. Speech recognition requires internet connection.
        </p>
      </div>

      <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#ffebee', borderRadius: '8px' }}>
        <h3 style={{ marginTop: 0, color: '#c62828' }}>Troubleshooting Microphone Issues:</h3>
        <ul style={{ marginBottom: 0, fontSize: '14px' }}>
          <li><strong>Permission Denied:</strong> Click the microphone icon in your browser's address bar and allow access</li>
          <li><strong>No Microphone:</strong> Make sure a microphone is connected and working</li>
          <li><strong>Already in Use:</strong> Close other apps that might be using your microphone (Zoom, Teams, etc.)</li>
          <li><strong>HTTPS Required:</strong> This app needs HTTPS in production (localhost works for development)</li>
          <li><strong>Browser Support:</strong> Use Chrome, Firefox, Safari, or Edge for best results</li>
        </ul>
      </div>
    </>
  );
}

export default Instructions;