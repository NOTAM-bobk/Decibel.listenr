import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Audio Processing State
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState(null);
  
  // Decibel Values
  const [currentDb, setCurrentDb] = useState(0);
  const [maxDb, setMaxDb] = useState(0);
  const [minDb, setMinDb] = useState(999);
  const [avgDb, setAvgDb] = useState(0);

  // Refs for Web Audio
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const animationFrameRef = useRef(null);

  // Accumulators for calculating Average
  const runningSumRef = useRef(0);
  const countRef = useRef(0);

  // Visualizer Canvas Refs
  const graphCanvasRef = useRef(null);
  const rollingHistoryBuffer = useRef(Array(100).fill(0));

  // Helper to determine color based on dB level
  const getDbColor = (db) => {
    if (db < 60) return '#10B981'; // Green (Safe)
    if (db < 85) return '#F59E0B'; // Yellow (Warning)
    return '#EF4444'; // Red (Danger)
  };

  const currentColor = getDbColor(currentDb);

  // Initialize Audio
  const startRecording = async () => {
    try {
      setPermissionError(null);
      
      // Fix 1: Initialize AudioContext synchronously for iOS Safari
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContext();
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      // Fix 2: iOS forces audio contexts to start suspended.
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      
      // Fix 3: fftSize MUST be a power of 2
      analyser.fftSize = 512; 
      analyser.smoothingTimeConstant = 0.8; // Smooth out the jumps
      source.connect(analyser);
      analyserRef.current = analyser;

      setIsRecording(true);
      runningSumRef.current = 0;
      countRef.current = 0;
      setMaxDb(0);
      setMinDb(999);
      rollingHistoryBuffer.current = Array(100).fill(0);

      tick();
    } catch (err) {
      console.error(err);
      setPermissionError('Microphone access denied. Please allow microphone permissions in Safari settings.');
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
    // Reset baseline display but keep history
    setCurrentDb(0);
  };

  // Main processing loop
  const tick = () => {
    if (!isRecording && !analyserRef.current) return;

    const analyser = analyserRef.current;
    if (!analyser) return;

    const bufferLength = analyser.fftSize;
    let sum = 0;

    // Fix 4: Fallback for older iOS Safari versions
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

    // AUTOMATIC CALIBRATION:
    // Map hardware float RMS to a standard 115 SPL full-scale baseline
    let db = 0; 
    if (rms > 0.0001) {
      db = 20 * Math.log10(rms) + 115;
    }
    
    // Clamp to realistic 0-130 range
    db = Math.max(0, Math.min(db, 130));

    // Fast-acting exponential smoothing for natural gauge movement
    setCurrentDb(prev => {
      const nextVal = prev + (db - prev) * 0.25;
      const roundedVal = parseFloat(nextVal.toFixed(1));

      if (roundedVal > 0) {
        setMaxDb(currentMax => Math.max(currentMax, roundedVal));
        setMinDb(currentMin => currentMin === 999 ? roundedVal : Math.min(currentMin, roundedVal));
        
        runningSumRef.current += roundedVal;
        countRef.current += 1;
        setAvgDb(parseFloat((runningSumRef.current / countRef.current).toFixed(1)));
      }

      rollingHistoryBuffer.current.shift();
      rollingHistoryBuffer.current.push(roundedVal);

      return roundedVal;
    });

    drawGraph();
    animationFrameRef.current = requestAnimationFrame(tick);
  };

  const drawGraph = () => {
    const canvas = graphCanvasRef.current;
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

    // Draw Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    [20, 40, 60, 80, 100, 120].forEach(val => {
      const y = height - (val / 130) * height;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    });
    ctx.stroke();

    const data = rollingHistoryBuffer.current;
    
    ctx.beginPath();
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    
    // Dynamic Gradient based on current level
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#10B981'); // Safe
    grad.addColorStop(0.65, '#F59E0B'); // Warn
    grad.addColorStop(1, '#EF4444'); // Danger
    ctx.strokeStyle = grad;

    const sliceWidth = width / (data.length - 1);
    for (let i = 0; i < data.length; i++) {
      const dbVal = data[i];
      const x = i * sliceWidth;
      const y = height - (dbVal / 130) * height;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under line
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, 'rgba(245, 158, 11, 0.2)');
    fillGrad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = fillGrad;
    ctx.fill();
  };

  useEffect(() => {
    if (isRecording) tick();
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [isRecording]);

  useEffect(() => {
    const handleResize = () => drawGraph();
    window.addEventListener('resize', handleResize);
    drawGraph(); // Draw initial empty state
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const resetStats = () => {
    setMaxDb(currentDb);
    setMinDb(currentDb);
    runningSumRef.current = currentDb;
    countRef.current = 1;
    setAvgDb(currentDb);
  };

  // SVG Gauge Math
  const gaugeRadius = 90;
  const gaugeCircumference = Math.PI * gaugeRadius; // Half circle
  const dashOffset = gaugeCircumference - (currentDb / 130) * gaugeCircumference;

  return (
    <div className="min-h-screen bg-[#0f111a] text-white flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      
      {/* Navbar */}
      <header className="bg-[#161a27] border-b border-slate-800 p-4 shadow-sm flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <h1 className="font-bold text-lg tracking-tight text-slate-100">Decibel Meter</h1>
        </div>
        <div className="text-xs text-slate-400 font-medium px-2 py-1 bg-slate-800 rounded">
          Automatic Spl
        </div>
      </header>

      {permissionError && (
        <div className="bg-red-500/10 border-l-4 border-red-500 p-4 m-4 text-red-200 text-sm">
          {permissionError}
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col items-center p-4 max-w-2xl mx-auto w-full">
        
        {/* Large Meter Gauge Component */}
        <div className="relative w-full aspect-[2/1] max-w-[400px] mt-8 mb-4">
          <svg viewBox="0 0 200 110" className="w-full h-full overflow-visible">
            {/* Background Track */}
            <path
              d="M 10 100 A 90 90 0 0 1 190 100"
              fill="none"
              stroke="#1e2436"
              strokeWidth="14"
              strokeLinecap="round"
            />
            {/* Colored Dynamic Fill */}
            <path
              d="M 10 100 A 90 90 0 0 1 190 100"
              fill="none"
              stroke={currentColor}
              strokeWidth="14"
              strokeLinecap="round"
              strokeDasharray={gaugeCircumference}
              strokeDashoffset={dashOffset}
              className="transition-all duration-75 ease-linear"
            />
          </svg>
          
          {/* Centered Numbers */}
          <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center translate-y-2">
            <div className="flex items-baseline gap-1" style={{ color: currentColor }}>
              <span className="text-7xl md:text-8xl font-black tabular-nums tracking-tighter">
                {Math.round(currentDb)}
              </span>
              <span className="text-xl md:text-2xl font-bold opacity-80">dB</span>
            </div>
            <span className="text-xs text-slate-400 uppercase tracking-widest font-semibold mt-1">
              {isRecording ? 'Listening' : 'Standby'}
            </span>
          </div>
        </div>

        {/* Stats Row */}
        <div className="w-full grid grid-cols-3 gap-3 my-8">
          <div className="bg-[#161a27] rounded-xl p-3 flex flex-col items-center justify-center border border-slate-800">
            <span className="text-xs text-slate-400 uppercase font-semibold mb-1">Min</span>
            <span className="text-xl font-bold tabular-nums text-slate-200">
              {minDb === 999 ? '0' : Math.round(minDb)}
            </span>
          </div>
          <div className="bg-[#161a27] rounded-xl p-3 flex flex-col items-center justify-center border border-slate-800">
            <span className="text-xs text-slate-400 uppercase font-semibold mb-1">Avg</span>
            <span className="text-xl font-bold tabular-nums text-slate-200">
              {Math.round(avgDb)}
            </span>
          </div>
          <div className="bg-[#161a27] rounded-xl p-3 flex flex-col items-center justify-center border border-slate-800">
            <span className="text-xs text-slate-400 uppercase font-semibold mb-1">Max</span>
            <span className="text-xl font-bold tabular-nums text-slate-200">
              {Math.round(maxDb)}
            </span>
          </div>
        </div>

        {/* Start / Stop Control */}
        <div className="mb-10 w-full flex justify-center">
          {!isRecording ? (
            <button
              onClick={startRecording}
              className="w-48 h-16 rounded-full bg-emerald-500 text-slate-950 font-bold text-lg shadow-[0_0_30px_rgba(16,185,129,0.3)] active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              Start Meter
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={stopRecording}
                className="w-40 h-16 rounded-full bg-red-500/10 border border-red-500/50 text-red-400 font-bold text-lg active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
                Stop
              </button>
              <button
                onClick={resetStats}
                className="w-16 h-16 rounded-full bg-[#161a27] border border-slate-800 text-slate-300 hover:text-white active:scale-95 transition-all flex items-center justify-center"
                aria-label="Reset Stats"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </button>
            </div>
          )}
        </div>

        {/* Real-time Line Graph */}
        <div className="w-full bg-[#161a27] rounded-2xl border border-slate-800 p-4 flex-1 min-h-[200px] flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <span className="text-xs font-bold text-slate-400 uppercase">History Timeline</span>
            <span className="text-[10px] text-slate-500">0 - 130 dB SPL</span>
          </div>
          <div className="relative flex-1 w-full bg-[#0f111a] rounded-lg border border-slate-800 overflow-hidden">
            <canvas ref={graphCanvasRef} className="absolute inset-0 w-full h-full" />
          </div>
        </div>

      </main>
    </div>
  );
}
