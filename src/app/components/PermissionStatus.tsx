function PermissionStatus({ 
  status, 
  onRequestPermission, 
  onTestMicrophone, 
  devices 
}: { 
  status: string;
  onRequestPermission: () => void;
  onTestMicrophone: () => void;
  devices: MediaDeviceInfo[];
}) {
  if (status === 'unknown') return null;

  return (
    <div style={{ marginTop: '15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <span style={{ fontSize: '14px' }}>
          Microphone Permission: 
          <span style={{ 
            color: status === 'granted' ? '#4CAF50' : 
                   status === 'denied' ? '#f44336' : '#ff9800',
            fontWeight: 'bold',
            marginLeft: '5px'
          }}>
            {status === 'granted' ? '✅ Granted' : 
             status === 'denied' ? '❌ Denied' : '⏳ Not Requested'}
          </span>
        </span>
      </div>
      
      {status !== 'granted' && (
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={onRequestPermission}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              backgroundColor: '#2196F3',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🎤 Request Microphone Permission
          </button>
          <button
            onClick={onTestMicrophone}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              backgroundColor: '#ff9800',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            🔧 Test Microphone
          </button>
        </div>
      )}
      
      {devices.length > 0 && (
        <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
          <strong>Available Microphones ({devices.length}):</strong>
          <ul style={{ margin: '5px 0', paddingLeft: '20px' }}>
            {devices.map((device, index) => (
              <li key={device.deviceId}>
                {device.label || `Microphone ${index + 1}`} 
                {device.deviceId === 'default' && ' (Default)'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default PermissionStatus;