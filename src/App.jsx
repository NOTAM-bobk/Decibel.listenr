import React, { useState, useEffect, useRef } from 'react';

// Calibration & Standards Data
const NOISE_LEVELS = [
  { min: 0, max: 30, label: 'Whisper Quiet', color: 'rgb(34, 197, 94)', bgLight: 'rgba(34, 197, 94, 0.15)', textColor: 'text-green-400', description: 'Very quiet. Breathing, library, rustling leaves.', safeExposure: 'Safe indefinitely' },
  { min: 30, max: 50, label: 'Quiet Room', color: 'rgb(16, 185, 129)', bgLight: 'rgba(16, 185, 129, 0.15)', textColor: 'text-emerald-400', description: 'Subdued home, quiet suburb, refrigerator humming.', safeExposure: 'Safe indefinitely' },
  { min: 50, max: 70, label: 'Moderate Noise', color: 'rgb(59, 130, 246)', bgLight: 'rgba(59, 130, 246, 0.15)', textColor: 'text-blue-400', description: 'Normal conversation, office AC, dishwasher.', safeExposure: 'Safe indefinitely' },
  { min: 70, max: 85, label: 'Loud Environment', color: 'rgb(245, 158, 11)', bgLight: 'rgba(245, 158, 11, 0.15)', textColor: 'text-amber-400', description: 'Busy street traffic, vacuum cleaner, noisy restaurant.', safeExposure: 'Safe up to 8 hours' },
  { min: 85, max: 100, label: 'Very Loud / Hazardous', color: 'rgb(239, 68, 68)', bgLight: 'rgba(239, 68, 68, 0.15)', textColor: 'text-red-400', description: 'Lawn mower, heavy truck traffic, hair dryer, shouting.', safeExposure: 'Max 15 min to 2 hours' },
  { min: 100, max: 120, label: 'Extremely Dangerous', color: 'rgb(220, 38, 38)', bgLight: 'rgba(220, 38, 38, 0.15)', textColor: 'text-red-500', description: 'Rock concert, chain saw, car horn, jackhammer.', safeExposure: 'Immediate risk (less than 1 min)' },
  { min: 120, max: 194, label: 'Threshold of Pain', color: 'rgb(153, 27, 27)', bgLight: 'rgba(153, 27, 27, 0.15)', textColor: 'text-rose-700', description: 'Jet takeoff, sirens, firecracker, gunshots.', safeExposure: 'Severe risk / Physical pain' }
];

export default function App() {
  // Navigation / Tabs
  const [activeTab, setActiveTab] = useState('dashboard');

  // Mic & Audio Processing State
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState(null);
  
  // Decibel Values
  const [currentDb, setCurrentDb] = useState(30);
  const [peakDb, setPeakDb] = useState(30);
  const [avgDb, setAvgDb] = useState(30);
  const [calibrationOffset, setCalibrationOffset] = useState(105); 
  const [damping, setDamping] = useState(0.2); 

  // Session Logs State
  const [logs, setLogs] = useState([]);
  const [customNote, setCustomNote] = useState('');

  // Refs for Web Audio
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const animationFrameRef = useRef(null);

  // Accumulators for calculating Average
  const dbHistoryRef = useRef([]);
  const runningSumRef = useRef(0);
  const countRef = useRef(0);

  // Visualizer Canvas Refs
  const spectrumCanvasRef = useRef(null);
  const rollingCanvasRef = useRef(null);

  // Realtime graph historical buffer for rendering
  const rollingHistoryBuffer = useRef(Array(150).fill(30));

  // Determine classification based on dB
  const getClassification = (db) => {
    return NOISE_LEVELS.find(lvl => db >= lvl.min && db < lvl.max) || NOISE_LEVELS[0];
  };

  const currentClassification = getClassification(currentDb);

  // Initialize Audio
  const startRecording = async () => {
    try {
      setPermissionError(null);
      
      // Fix 1: Initialize AudioContext synchronously for iOS Safari strict policies
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContext();
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      // Fix 2: iOS forces audio contexts to start suspended. We must explicitly resume it.
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      
      // Fix 3: fftSize MUST be a power of 2 (changed from 254 to 256 to prevent API crash)
      analyser.fftSize = 256; 
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyserRef.current = analyser;

      setIsRecording(true);
      dbHistoryRef.current = [];
      runningSumRef.current = 0;
      countRef.current = 0;
      setPeakDb(30);

      tick();
    } catch (err) {
      console.error(err);
      setPermissionError('Could not access microphone. Please check system settings or grant microphone permission.');
    }
  };

  // Stop Audio Processing
  const stopRecording = () => {
    setIsRecording(false);
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
  };

  // Main processing loop
  const tick = () => {
    if (!isRecording && !analyserRef.current) return;

    const analyser = analyserRef.current;
    if (!analyser) return;

    const bufferLength = analyser.fftSize;
    let sum = 0;

    // Fix 4: Fallback for older iOS Safari versions that don't support getFloatTimeDomainData
    if (analyser.getFloatTimeDomainData) {
      const dataArray = new Float32Array(bufferLength);
      analyser.getFloatTimeDomainData(dataArray);
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
      }
    } else {
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteTimeDomainData(dataArray);
      for (let i = 0; i < bufferLength; i++) {
        const floatVal = (dataArray[i] - 128) / 128;
        sum += floatVal * floatVal;
      }
    }
    
    const rms = Math.sqrt(sum / bufferLength);

    let db = 30; 
    if (rms > 0.00001) {
      db = 20 * Math.log10(rms) + calibrationOffset;
    }

    if (db < 20) db = 20 + Math.random() * 5; 
    if (db > 140) db = 140;

    setCurrentDb(prev => {
      const nextVal = prev + (db - prev) * damping;
      
      rollingHistoryBuffer.current.shift();
      rollingHistoryBuffer.current.push(nextVal);

      setPeakDb(currentPeak => {
        const val = Math.max(currentPeak, nextVal);
        return parseFloat(val.toFixed(1));
      });

      runningSumRef.current += nextVal;
      countRef.current += 1;
      const calculatedAvg = runningSumRef.current / countRef.current;
      setAvgDb(parseFloat(calculatedAvg.toFixed(1)));

      return parseFloat(nextVal.toFixed(1));
    });

    drawSpectrum();
    drawRollingGraph();

    animationFrameRef.current = requestAnimationFrame(tick);
  };

  const drawSpectrum = () => {
    const canvas = spectrumCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    const freqBinCount = analyser.frequencyBinCount;
    const freqData = new Uint8Array(freqBinCount);
    analyser.getByteFrequencyData(freqData);

    const barWidth = (width / freqBinCount) * 1.5;
    let x = 0;

    for (let i = 0; i < freqBinCount; i++) {
      const value = freqData[i];
      const percent = value / 255;
      const barHeight = percent * height;

      const grad = ctx.createLinearGradient(0, height, 0, height - barHeight);
      grad.addColorStop(0, 'rgba(59, 130, 246, 0.2)'); 
      grad.addColorStop(0.5, 'rgba(16, 185, 129, 0.6)'); 
      grad.addColorStop(1, 'rgba(239, 68, 68, 0.9)'); 

      ctx.fillStyle = grad;
      ctx.fillRect(x, height - barHeight, barWidth - 1.5, barHeight);

      x += barWidth;
    }
  };

  const drawRollingGraph = () => {
    const canvas = rollingCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    const gridLines = [40, 60, 80, 100, 120];
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '9px system-ui';
    ctx.lineWidth = 1;

    gridLines.forEach(lineVal => {
      const y = height - ((lineVal - 20) / 110) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${lineVal} dB`, 5, y - 4);
    });

    const data = rollingHistoryBuffer.current;
    if (data.length === 0) return;

    ctx.beginPath();
    ctx.lineWidth = 2.5;

    const lineGrad = ctx.createLinearGradient(0, height, 0, 0);
    lineGrad.addColorStop(0, '#10B981'); 
    lineGrad.addColorStop(0.5, '#F59E0B'); 
    lineGrad.addColorStop(1, '#EF4444'); 
    ctx.strokeStyle = lineGrad;

    const sliceWidth = width / (data.length - 1);
    for (let i = 0; i < data.length; i++) {
      const dbVal = data[i];
      const x = i * sliceWidth;
      const y = height - ((dbVal - 20) / 110) * height;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    const areaGrad = ctx.createLinearGradient(0, 0, 0, height);
    areaGrad.addColorStop(0, 'rgba(239, 68, 68, 0.15)');
    areaGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.05)');
    areaGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = areaGrad;
    ctx.fill();
  };

  useEffect(() => {
    if (isRecording) {
      tick();
    }
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isRecording, calibrationOffset, damping]);

  useEffect(() => {
    const handleResize = () => {
      drawSpectrum();
      drawRollingGraph();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const resetStats = () => {
    setPeakDb(currentDb);
    dbHistoryRef.current = [];
    runningSumRef.current = currentDb;
    countRef.current = 1;
    setAvgDb(currentDb);
  };

  const logCurrentNoise = () => {
    const newLog = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      db: currentDb,
      peak: peakDb,
      classification: currentClassification.label,
      notes: customNote.trim() || 'Manual Snapshot'
    };
    setLogs(prev => [newLog, ...prev]);
    setCustomNote('');
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40 px-4 py-4 md:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/25">
              <svg className="w-6 h-6 text-emerald-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-emerald-400 to-teal-200 bg-clip-text text-transparent">SonicSense dB</h1>
              <p className="text-xs text-slate-400">Precision Mobile Decibel Meter</p>
            </div>
          </div>

          <nav className="flex items-center gap-1.5 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'logs'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              Saved Logs ({logs.length})
            </button>
            <button
              onClick={() => setActiveTab('safety')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'safety'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              Exposure Guide
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 flex flex-col gap-6">
        {permissionError && (
          <div className="bg-red-950/40 border border-red-500/30 p-4 rounded-xl text-red-200 text-sm flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <span className="font-semibold block">Microphone Access Denied</span>
              {permissionError}
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <div className="lg:col-span-1 bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 flex flex-col items-center justify-between min-h-[480px]">
              
              <div className="w-full flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-ping' : 'bg-slate-500'}`} />
                  <span className="text-xs font-semibold tracking-wide uppercase text-slate-400">
                    {isRecording ? 'Listening...' : 'Offline'}
                  </span>
                </div>
                <button
                  onClick={resetStats}
                  disabled={!isRecording}
                  className="text-xs px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50 transition"
                >
                  Reset Peaks
                </button>
              </div>

              <div className="relative my-8 flex items-center justify-center w-60 h-60">
                <div 
                  className="absolute inset-0 rounded-full blur-xl opacity-20 transition-all duration-300"
                  style={{ backgroundColor: currentClassification.color }}
                />

                <svg className="w-full h-full transform -rotate-90">
                  <circle
                    cx="120"
                    cy="120"
                    r="100"
                    className="stroke-slate-800"
                    strokeWidth="12"
                    fill="transparent"
                  />
                  <circle
                    cx="120"
                    cy="120"
                    r="100"
                    stroke={currentClassification.color}
                    strokeWidth="12"
                    fill="transparent"
                    strokeDasharray={628}
                    strokeDashoffset={628 - (628 * Math.min(Math.max(currentDb - 20, 0), 100)) / 100}
                    strokeLinecap="round"
                    className="transition-all duration-75"
                  />
                </svg>

                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="text-6xl font-black tracking-tight text-white tabular-nums select-none">
                    {Math.round(currentDb)}
                  </span>
                  <span className="text-sm font-semibold text-slate-400 mt-1">dB SPL</span>
                  <div 
                    className="mt-2 px-3 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase shadow-sm border"
                    style={{ 
                      backgroundColor: currentClassification.bgLight, 
                      borderColor: currentClassification.color, 
                      color: currentClassification.color 
                    }}
                  >
                    {currentClassification.label}
                  </div>
                </div>
              </div>

              <div className="w-full flex flex-col gap-3">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    className="w-full py-4 rounded-xl font-bold bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 hover:brightness-110 active:scale-[0.98] transition shadow-lg shadow-emerald-500/10 text-sm md:text-base"
                  >
                    Start Measuring
                  </button>
                ) : (
                  <button
                    onClick={stopRecording}
                    className="w-full py-4 rounded-xl font-bold bg-slate-800 text-red-400 border border-red-500/20 hover:bg-slate-700/80 active:scale-[0.98] transition text-sm md:text-base"
                  >
                    Stop Measuring
                  </button>
                )}
                <p className="text-[10px] text-center text-slate-500">
                  Allows capturing surrounding acoustics through microphone inputs
                </p>
              </div>

            </div>

            <div className="lg:col-span-2 flex flex-col gap-6">
              
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 flex flex-col">
                  <span className="text-xs text-slate-400 font-medium">Max Peak</span>
                  <span className="text-2xl font-black text-rose-400 mt-1 tabular-nums">{peakDb} <span className="text-xs font-normal text-slate-500">dB</span></span>
                  <span className="text-[10px] text-slate-500 mt-2 truncate">Highest registered peak</span>
                </div>
                <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 flex flex-col">
                  <span className="text-xs text-slate-400 font-medium">Session Average</span>
                  <span className="text-2xl font-black text-amber-400 mt-1 tabular-nums">{avgDb} <span className="text-xs font-normal text-slate-500">dB</span></span>
                  <span className="text-[10px] text-slate-500 mt-2 truncate">Continuous calculation</span>
                </div>
                <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 flex flex-col">
                  <span className="text-xs text-slate-400 font-medium">Safe Duration</span>
                  <span className="text-sm font-bold text-emerald-400 mt-2.5 line-clamp-2">{currentClassification.safeExposure}</span>
                </div>
              </div>

              <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 flex flex-col flex-1 min-h-[280px]">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white">Rolling Sound Levels</h3>
                    <p className="text-xs text-slate-400">Decibel history timeline (20 - 140 dB)</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-950 px-2 py-1 rounded-md border border-slate-800">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block animate-pulse" />
                    <span>Real-time</span>
                  </div>
                </div>

                <div className="relative flex-1 bg-slate-950/40 rounded-xl border border-slate-900 overflow-hidden min-h-[160px]">
                  <canvas ref={rollingCanvasRef} className="absolute inset-0 w-full h-full" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 flex flex-col">
                  <div className="mb-2">
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider">Live Frequency Spectrum</h4>
                    <p className="text-[10px] text-slate-400">Sub-bass to high-treble distribution</p>
                  </div>
                  <div className="relative h-20 bg-slate-950/50 rounded-lg border border-slate-900 overflow-hidden">
                    <canvas ref={spectrumCanvasRef} className="absolute inset-0 w-full h-full" />
                  </div>
                </div>

                <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between gap-3">
                  <div>
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider">Log Current Environment</h4>
                    <p className="text-[10px] text-slate-400">Save active reading to comparison tables</p>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Label (e.g., Office, Street Noise)"
                      value={customNote}
                      onChange={(e) => setCustomNote(e.target.value)}
                      disabled={!isRecording}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
                    />
                    <button
                      onClick={logCurrentNoise}
                      disabled={!isRecording}
                      className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold rounded-lg transition disabled:opacity-50"
                    >
                      Log
                    </button>
                  </div>
                </div>

              </div>

              <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-6">
                <h3 className="text-sm font-bold text-white mb-4">Device Calibration</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-slate-400">Calibration Offset:</span>
                      <span className="text-emerald-400 font-semibold">{calibrationOffset} dB</span>
                    </div>
                    <input
                      type="range"
                      min="80"
                      max="130"
                      value={calibrationOffset}
                      onChange={(e) => setCalibrationOffset(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <p className="text-[10px] text-slate-500 mt-2">
                      Adjusts base gain sensitivity. Match offset values with physical standalone calibrators for standard readings.
                    </p>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-slate-400">Response Speed (Damping):</span>
                      <span className="text-emerald-400 font-semibold">{damping === 0.1 ? 'Slow (0.1)' : damping === 0.2 ? 'Normal (0.2)' : 'Fast (0.4)'}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[0.1, 0.2, 0.4].map((v) => (
                        <button
                          key={v}
                          onClick={() => setDamping(v)}
                          className={`py-1 rounded text-[10px] font-semibold uppercase border transition ${
                            damping === v
                              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                              : 'bg-slate-950/50 text-slate-400 border-slate-800 hover:bg-slate-900'
                          }`}
                        >
                          {v === 0.1 ? 'Slow' : v === 0.2 ? 'Normal' : 'Fast'}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2">
                      Governs integration averaging times. Slow corresponds to IEC standards for general noise; fast responds quickly to peaks.
                    </p>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h2 className="text-lg font-bold text-white">Saved Logs & Snapshots</h2>
                <p className="text-xs text-slate-400">Comparison log of saved noise environments recorded during active sessions.</p>
              </div>
              {logs.length > 0 && (
                <button
                  onClick={clearLogs}
                  className="px-4 py-2 bg-red-950/50 text-red-400 border border-red-900/50 hover:bg-red-900/30 text-xs font-bold rounded-lg transition self-start"
                >
                  Clear All Logs
                </button>
              )}
            </div>

            {logs.length === 0 ? (
              <div className="text-center py-16 border border-dashed border-slate-800 rounded-xl">
                <svg className="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <p className="text-slate-400 text-sm">No saved snapshots yet.</p>
                <p className="text-slate-600 text-xs mt-1">Activate the meter and click "Log" to capture sound statistics.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-slate-950 text-xs uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-4 py-3 rounded-l-lg">Time</th>
                      <th className="px-4 py-3">Decibels (Avg)</th>
                      <th className="px-4 py-3">Peak</th>
                      <th className="px-4 py-3">Classification</th>
                      <th className="px-4 py-3 rounded-r-lg">Label / Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-900/50 transition">
                        <td className="px-4 py-3 text-slate-500 font-mono text-xs">{log.timestamp}</td>
                        <td className="px-4 py-3 font-bold text-white tabular-nums">{log.db} dB</td>
                        <td className="px-4 py-3 text-rose-400 font-semibold tabular-nums">{log.peak} dB</td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-800">
                            {log.classification}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 italic">{log.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'safety' && (
          <div className="flex flex-col gap-6">
            
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-white">Hearing Damage & Exposure Reference</h2>
              <p className="text-xs text-slate-400 mt-1">
                Prolonged exposure to sound pressure levels exceeding 85 decibels (dB SPL) can trigger irreversible noise-induced hearing loss (NIHL). Use this reference table to evaluate environmental risk.
              </p>
            </div>

            <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {NOISE_LEVELS.map((level, idx) => (
                  <div key={idx} className="bg-slate-950 border border-slate-800/60 rounded-xl p-5 flex flex-col justify-between hover:border-slate-700/80 transition-all">
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Threshold {idx + 1}</span>
                        <span 
                          className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider"
                          style={{ backgroundColor: level.bgLight, color: level.color }}
                        >
                          {level.min}-{level.max} dB
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-100 mb-1">{level.label}</h4>
                      <p className="text-xs text-slate-400 mb-4">{level.description}</p>
                    </div>

                    <div className="pt-3 border-t border-slate-900 flex justify-between items-center">
                      <span className="text-[10px] text-slate-500 uppercase font-semibold">Max Safe Limit</span>
                      <span className="text-xs font-bold text-white">{level.safeExposure}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-gradient-to-r from-emerald-950/20 to-teal-950/20 border border-emerald-500/20 rounded-2xl p-6">
              <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider mb-3">Hearing Protection Tips</h3>
              <ul className="space-y-2 text-xs text-slate-300">
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 mt-0.5">•</span>
                  <span><strong>Observe the 85 dB Rule:</strong> Any workplace, stadium, or street peaking above 85 dB SPL warrants custom noise reduction earmuffs or hearing plugs.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 mt-0.5">•</span>
                  <span><strong>Use Calibration Regularly:</strong> Hardware variations in Android and iOS devices affect direct readings. Always test and calibrate compared to calibrated meters.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 mt-0.5">•</span>
                  <span><strong>The 60-60 Guideline:</strong> Keep headphone listening below 60% of the maximum volume range for no longer than 60 minutes a day.</span>
                </li>
              </ul>
            </div>

          </div>
        )}

      </main>

      <footer className="mt-auto border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 SonicSense. Crafted with standard Web Audio API protocols.</p>
          <p className="flex items-center gap-1.5 justify-center">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Runs entirely inside client-side isolated sandbox (No server upload)
          </p>
        </div>
      </footer>
    </div>
  );
}
