function TranscriptDisplay({ transcripts }: { transcripts: Transcript[] }) {
  return (
    <div style={{
      backgroundColor: '#f5f5f5',
      padding: '20px',
      borderRadius: '8px',
      minHeight: '400px',
      maxHeight: '500px',
      overflowY: 'auto'
    }}>
      <h2 style={{ marginTop: 0, marginBottom: '20px' }}>Live Transcript</h2>
      
      {transcripts.length === 0 ? (
        <p style={{ color: '#999', fontStyle: 'italic' }}>
          Transcripts will appear here once the call starts...
        </p>
      ) : (
        <div>
          {transcripts.map((item, index) => (
            <div
              key={index}
              style={{
                marginBottom: '15px',
                padding: '12px',
                backgroundColor: item.speaker === 'You' ? '#e3f2fd' : '#fff3e0',
                borderRadius: '8px',
                borderLeft: `4px solid ${item.speaker === 'You' ? '#2196F3' : '#FF9800'}`
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <strong style={{ color: item.speaker === 'You' ? '#1976D2' : '#F57C00' }}>
                  {item.speaker}
                </strong>
                <span style={{ fontSize: '12px', color: '#666' }}>
                  {new Date(item.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p style={{ margin: 0 }}>{item.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TranscriptDisplay;