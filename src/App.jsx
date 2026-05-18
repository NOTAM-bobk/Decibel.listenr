import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Application State
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState(null);
  
  // Audio Recording State
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const audioChunksRef = useRef([]);

  // Decibel Values
  const [currentDb, setCurrentDb] = useState(0);
  const [maxDb, setMaxDb] = useState(0);
  const [minDb, setMinDb] = useState(999);
  const [avgDb, setAvgDb] = useState(0);

  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [calibrationOffset, setCalibrationOffset] = useState(2.0);
  const [updateRate, setUpdateRate] = useState('Fast'); // Fast, Slow
  const [weighting, setWeighting] = useState('Z'); // A, C, Z
  const [displayScale, setDisplayScale] = useState(130);
  const [graphType, setGraphType] = useState('Area'); // Area, Line, Bar

  // Refs for Web Audio
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const filterRef = useRef(null); // Biquad Filter for A/C/Z weighting
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
    if (db < 60) return '#4ade80'; // Bright Green (Safe)
    if (db < 85) return '#fde047'; // Bright Yellow (Warning)
    return '#f43f5e'; // Bright Rose/Red (Danger)
  };

  const currentColor = getDbColor(currentDb);

  // Apply filter weighting dynamically when settings change
  useEffect(() => {
    if (filterRef.current) {
      if (weighting === 'A') {
        filterRef.current.type = 'highpass';
        filterRef.current.frequency.value = 500; // Rough approximation of A-weighting bass roll-off
      } else if (weighting === 'C') {
        filterRef.current.type = 'highpass';
        filterRef.current.frequency.value = 30; // Rough approximation of C-weighting
      } else {
        filterRef.current.type = 'allpass'; // Z-weighting (Flat)
      }
    }
  }, [weighting]);

  // Initialize Audio
  const startRecording = async () => {
    try {
      setPermissionError(null);
      
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContext();
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const filter = audioCtx.createBiquadFilter();
      filterRef.current = filter;
      
      // Initial weighting setup
      if (weighting === 'A') { filter.type = 'highpass'; filter.frequency.value = 500; } 
      else if (weighting === 'C') { filter.type = 'highpass'; filter.frequency.value = 30; } 
      else { filter.type = 'allpass'; }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512; 
      
      source.connect(filter);
      filter.connect(analyser);
      analyserRef.current = analyser;

      // Setup MediaRecorder for audio recording feature
      if (window.MediaRecorder) {
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/mp4' });
          const url = URL.createObjectURL(blob);
          setAudioUrl(url);
          audioChunksRef.current = [];
        };
        setMediaRecorder(recorder);
      }

      setIsRecording(true);
      runningSumRef.current = 0;
      countRef.current = 0;
      setMaxDb(0);
      setMinDb(999);
      rollingHistoryBuffer.current = Array(100).fill(0);

      tick();
    } catch (err) {
      console.error(err);
      setPermissionError('Microphone access denied. Please allow microphone permissions in settings.');
    }
  };

  // Stop Audio Processing
  const stopRecording = () => {
    setIsRecording(false);
    if (isRecordingAudio && mediaRecorder) {
      mediaRecorder.stop();
      setIsRecordingAudio(false);
    }
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
    }
    setCurrentDb(0);
  };

  // Handle Manual Audio Recording Start/Stop
  const toggleAudioRecording = () => {
    if (!mediaRecorder) return;
    if (isRecordingAudio) {
      mediaRecorder.stop();
      setIsRecordingAudio(false);
    } else {
      setAudioUrl(null); // clear old
      audioChunksRef.current = [];
      mediaRecorder.start();
      setIsRecordingAudio(true);
    }
  };

  // Main processing loop
  const tick = () => {
    if (!isRecording && !analyserRef.current) return;

    const analyser = analyserRef.current;
    if (!analyser) return;

    // Apply Update Rate smoothing dynamically
    analyser.smoothingTimeConstant = updateRate === 'Slow' ? 0.9 : 0.4;

    const bufferLength = analyser.fftSize;
    let sum = 0;

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

    // Calculate DB with Calibration Offset
    let db = 0; 
    if (rms > 0.0001) {
      db = 20 * Math.log10(rms) + 115 + parseFloat(calibrationOffset);
    }
    
    db = Math.max(0, Math.min(db, displayScale));

    const dampingFactor = updateRate === 'Slow' ? 0.05 : 0.25;

    setCurrentDb(prev => {
      const nextVal = prev + (db - prev) * dampingFactor;
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
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gridSteps = [20, 40, 60, 80, 100, 120].filter(v => v <= displayScale);
    gridSteps.forEach(val => {
      const y = height - (val / displayScale) * height;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    });
    ctx.stroke();

    const data = rollingHistoryBuffer.current;
    const sliceWidth = width / (data.length - 1);
    
    // Dynamic Gradient based on current level
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#4ade80'); // Safe
    grad.addColorStop(0.65, '#fde047'); // Warn
    grad.addColorStop(1, '#f43f5e'); // Danger
    
    ctx.beginPath();
    
    if (graphType === 'Bar') {
      for (let i = 0; i < data.length; i++) {
        const dbVal = data[i];
        const barHeight = (dbVal / displayScale) * height;
        const x = i * sliceWidth;
        const y = height - barHeight;
        
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, sliceWidth - 1, barHeight);
      }
    } else {
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = grad;

      for (let i = 0; i < data.length; i++) {
        const dbVal = data[i];
        const x = i * sliceWidth;
        const y = height - (dbVal / displayScale) * height;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (graphType === 'Area') {
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(253, 224, 71, 0.3)'); // Yellow Tint
        fillGrad.addColorStop(1, 'rgba(74, 222, 128, 0)'); // Green Tint
        ctx.fillStyle = fillGrad;
        ctx.fill();
      }
    }
  };

  useEffect(() => {
    if (isRecording) tick();
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [isRecording, calibrationOffset, displayScale, updateRate, graphType]);

  useEffect(() => {
    const handleResize = () => drawGraph();
    window.addEventListener('resize', handleResize);
    drawGraph();
    return () => window.removeEventListener('resize', handleResize);
  }, [displayScale, graphType]);

  const resetStats = () => {
    setMaxDb(currentDb);
    setMinDb(currentDb);
    runningSumRef.current = currentDb;
    countRef.current = 1;
    setAvgDb(currentDb);
  };

  // SVG Gauge Math
  const gaugeRadius = 90;
  const gaugeCircumference = Math.PI * gaugeRadius; 
  const dashOffset = gaugeCircumference - (Math.min(currentDb, displayScale) / displayScale) * gaugeCircumference;

  return (
    <>
      {/* Dynamic Background Animation injected via style */}
      <style>{`
        @keyframes spotlight {
          0% { transform: translate(-30%, -30%) scale(1); opacity: 0.5; }
          33% { transform: translate(30%, 20%) scale(1.2); opacity: 0.3; }
          66% { transform: translate(-20%, 40%) scale(0.9); opacity: 0.4; }
          100% { transform: translate(-30%, -30%) scale(1); opacity: 0.5; }
        }
        .animate-spotlight {
          animation: spotlight 15s infinite alternate ease-in-out;
        }
      `}</style>

      <div className="relative min-h-screen bg-[#020617] text-white flex flex-col font-sans overflow-hidden selection:bg-emerald-500 selection:text-black">
        
        {/* Animated Spotlight Background */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none -z-10">
          <div className="absolute top-1/4 left-1/4 w-[60vw] h-[60vw] bg-emerald-500/20 rounded-full blur-[100px] animate-spotlight"></div>
          <div className="absolute bottom-1/4 right-1/4 w-[50vw] h-[50vw] bg-rose-500/10 rounded-full blur-[100px] animate-spotlight" style={{ animationDelay: '-5s' }}></div>
        </div>

        {/* Navbar (Neo-Brutalist Glassmorphism) */}
        <header className="bg-white/5 backdrop-blur-md border-b-2 border-slate-700 p-4 shadow-[0px_4px_0px_0px_#1e293b] flex items-center justify-between z-10 m-4 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-400 p-2 rounded-lg border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
              <svg className="w-5 h-5 text-slate-900" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h1 className="font-bold text-xl tracking-tight text-white drop-shadow-md">Decibel Pro</h1>
          </div>
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="bg-slate-800 hover:bg-slate-700 text-white p-2 rounded-xl border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a] active:translate-y-[2px] active:translate-x-[2px] active:shadow-[1px_1px_0px_0px_#0f172a] transition-all"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          </button>
        </header>

        {permissionError && (
          <div className="mx-4 bg-rose-500/20 backdrop-blur-md border-2 border-rose-500 p-4 rounded-xl shadow-[4px_4px_0px_0px_#e11d48] font-bold text-rose-100">
            {permissionError}
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col items-center p-4 max-w-2xl mx-auto w-full z-10">
          
          {/* Main Dial (Glass Panel) */}
          <div className="bg-white/5 backdrop-blur-lg border-2 border-slate-700 shadow-[6px_6px_0px_0px_#0f172a] rounded-3xl w-full p-8 flex flex-col items-center relative overflow-hidden">
            <div className="relative w-full aspect-[2/1] max-w-[350px]">
              <svg viewBox="0 0 200 110" className="w-full h-full overflow-visible">
                {/* Background Track */}
                <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke="#334155" strokeWidth="16" strokeLinecap="round" />
                {/* Colored Dynamic Fill */}
                <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke={currentColor} strokeWidth="16" strokeLinecap="round" strokeDasharray={gaugeCircumference} strokeDashoffset={dashOffset} className="transition-all duration-100 ease-out" />
              </svg>
              
              <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center translate-y-3">
                <div className="flex items-baseline gap-1" style={{ color: currentColor }}>
                  <span className="text-7xl md:text-8xl font-black tabular-nums tracking-tighter drop-shadow-lg">
                    {Math.round(currentDb)}
                  </span>
                  <span className="text-2xl font-bold opacity-90 drop-shadow-md">dB</span>
                </div>
                <span className="text-xs text-slate-300 uppercase tracking-widest font-bold mt-1 bg-slate-900/50 px-3 py-1 rounded-full border border-slate-700">
                  {isRecording ? 'Live Monitoring' : 'Standby'}
                </span>
              </div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="w-full grid grid-cols-3 gap-4 my-6">
            <div className="bg-emerald-500/10 backdrop-blur-md border-2 border-emerald-500 shadow-[4px_4px_0px_0px_#047857] rounded-2xl p-3 flex flex-col items-center justify-center">
              <span className="text-[10px] text-emerald-300 uppercase font-black tracking-wider mb-1">Min</span>
              <span className="text-xl font-black tabular-nums text-emerald-100">{minDb === 999 ? '0' : Math.round(minDb)}</span>
            </div>
            <div className="bg-blue-500/10 backdrop-blur-md border-2 border-blue-500 shadow-[4px_4px_0px_0px_#1d4ed8] rounded-2xl p-3 flex flex-col items-center justify-center">
              <span className="text-[10px] text-blue-300 uppercase font-black tracking-wider mb-1">Avg</span>
              <span className="text-xl font-black tabular-nums text-blue-100">{Math.round(avgDb)}</span>
            </div>
            <div className="bg-rose-500/10 backdrop-blur-md border-2 border-rose-500 shadow-[4px_4px_0px_0px_#be123c] rounded-2xl p-3 flex flex-col items-center justify-center">
              <span className="text-[10px] text-rose-300 uppercase font-black tracking-wider mb-1">Max</span>
              <span className="text-xl font-black tabular-nums text-rose-100">{Math.round(maxDb)}</span>
            </div>
          </div>

          {/* Primary Controls */}
          <div className="mb-6 w-full flex flex-col sm:flex-row justify-center gap-4">
            {!isRecording ? (
              <button onClick={startRecording} className="flex-1 max-w-[250px] mx-auto h-16 rounded-2xl bg-emerald-400 border-2 border-slate-900 text-slate-950 font-black text-lg shadow-[4px_4px_0px_0px_#047857] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#047857] transition-all flex items-center justify-center gap-2">
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                START METER
              </button>
            ) : (
              <>
                <button onClick={stopRecording} className="flex-1 h-16 rounded-2xl bg-slate-800 border-2 border-slate-900 text-slate-300 font-black text-lg shadow-[4px_4px_0px_0px_#0f172a] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#0f172a] transition-all flex items-center justify-center gap-2">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
                  STOP
                </button>
                <button onClick={resetStats} className="w-16 h-16 rounded-2xl bg-blue-400 border-2 border-slate-900 text-slate-900 shadow-[4px_4px_0px_0px_#1d4ed8] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#1d4ed8] transition-all flex items-center justify-center">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
                {/* Audio Recording Toggle */}
                {mediaRecorder && (
                  <button onClick={toggleAudioRecording} className={`flex-1 h-16 rounded-2xl border-2 border-slate-900 font-black text-lg shadow-[4px_4px_0px_0px_#9f1239] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#9f1239] transition-all flex items-center justify-center gap-2 ${isRecordingAudio ? 'bg-rose-500 text-white animate-pulse' : 'bg-rose-400 text-slate-900'}`}>
                    <div className={`w-4 h-4 rounded-full ${isRecordingAudio ? 'bg-white' : 'bg-rose-900'}`}></div>
                    {isRecordingAudio ? 'REC...' : 'RECORD'}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Audio Playback & Download Panel */}
          {audioUrl && !isRecordingAudio && (
            <div className="w-full bg-slate-800/80 backdrop-blur-md border-2 border-emerald-400 shadow-[4px_4px_0px_0px_#047857] p-4 rounded-2xl mb-6 flex flex-col md:flex-row items-center gap-4 justify-between">
              <audio src={audioUrl} controls className="w-full md:w-auto flex-1 h-10 custom-audio" />
              <a 
                href={audioUrl} 
                download="decibel-recording.webm"
                className="bg-emerald-400 text-slate-900 px-4 py-2 rounded-xl font-bold border-2 border-slate-900 shadow-[2px_2px_0px_0px_#047857] hover:translate-y-1 hover:translate-x-1 hover:shadow-none transition-all whitespace-nowrap text-sm"
              >
                💾 Download Audio
              </a>
            </div>
          )}

          {/* Real-time Graph (Glass Panel) */}
          <div className="w-full bg-white/5 backdrop-blur-lg rounded-3xl border-2 border-slate-700 shadow-[6px_6px_0px_0px_#0f172a] p-5 flex-1 min-h-[220px] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <span className="text-sm font-black text-white uppercase drop-shadow-md">Live Timeline</span>
              <span className="text-xs font-bold text-slate-400 bg-slate-900/50 px-2 py-1 rounded-md border border-slate-700">0 - {displayScale} dB</span>
            </div>
            <div className="relative flex-1 w-full bg-[#020617]/50 rounded-xl border-2 border-slate-800 overflow-hidden shadow-inner">
              <canvas ref={graphCanvasRef} className="absolute inset-0 w-full h-full" />
            </div>
          </div>

          {/* Disclaimer */}
          <p className="mt-8 text-center text-[10px] text-slate-500 max-w-md mx-auto leading-relaxed">
            <strong>Disclaimer:</strong> This application utilizes browser-based Web Audio APIs for educational and entertainment purposes. Hardware microphone limitations prevent clinical accuracy. Do not use this tool for formal occupational safety (OSHA) compliance or medical diagnostic purposes.
          </p>

        </main>
      </div>

      {/* Settings Modal Overlay */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm">
          <div className="bg-slate-900 border-2 border-slate-700 shadow-[8px_8px_0px_0px_#000] rounded-3xl p-6 w-full max-w-md animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
              <h2 className="text-xl font-black text-white">⚙️ Configurations</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-white bg-slate-800 p-2 rounded-xl border border-slate-700">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="space-y-5">
              {/* Calibration */}
              <div>
                <div className="flex justify-between text-sm font-bold text-slate-300 mb-2">
                  <label>Calibration Offset</label>
                  <span className="text-emerald-400">+{calibrationOffset} dB</span>
                </div>
                <input 
                  type="range" min="-20" max="20" step="0.5" 
                  value={calibrationOffset} 
                  onChange={(e) => setCalibrationOffset(e.target.value)}
                  className="w-full accent-emerald-500" 
                />
              </div>

              {/* Update Rate */}
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-2">Display Update Rate</label>
                <div className="grid grid-cols-2 gap-3">
                  {['Fast', 'Slow'].map(mode => (
                    <button key={mode} onClick={() => setUpdateRate(mode)} className={`py-2 font-bold rounded-xl border-2 transition-all ${updateRate === mode ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[2px_2px_0px_0px_#10b981]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Frequency Weighting */}
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-2">Frequency Weighting</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { val: 'Z', label: 'Z (Flat)' },
                    { val: 'A', label: 'A (Ear)' },
                    { val: 'C', label: 'C (Peak)' }
                  ].map(mode => (
                    <button key={mode.val} onClick={() => setWeighting(mode.val)} className={`py-2 text-xs font-bold rounded-xl border-2 transition-all ${weighting === mode.val ? 'bg-blue-500/20 border-blue-500 text-blue-400 shadow-[2px_2px_0px_0px_#3b82f6]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Graph Type */}
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-2">Timeline Graph Type</label>
                <div className="grid grid-cols-3 gap-3">
                  {['Area', 'Line', 'Bar'].map(mode => (
                    <button key={mode} onClick={() => setGraphType(mode)} className={`py-2 text-xs font-bold rounded-xl border-2 transition-all ${graphType === mode ? 'bg-rose-500/20 border-rose-500 text-rose-400 shadow-[2px_2px_0px_0px_#e11d48]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Display Scale */}
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-2">Display Scale Max (dB)</label>
                <select value={displayScale} onChange={(e) => setDisplayScale(Number(e.target.value))} className="w-full bg-slate-800 border-2 border-slate-700 text-white font-bold rounded-xl p-3 outline-none focus:border-emerald-500">
                  <option value={100}>100 dB (Standard)</option>
                  <option value={130}>130 dB (Extended)</option>
                  <option value={160}>160 dB (Extreme)</option>
                </select>
              </div>
            </div>
            
            <button onClick={() => setIsSettingsOpen(false)} className="mt-8 w-full py-3 bg-emerald-400 text-slate-900 font-black rounded-xl border-2 border-slate-900 shadow-[4px_4px_0px_0px_#047857] active:translate-y-[2px] active:translate-x-[2px] active:shadow-[2px_2px_0px_0px_#047857]">
              SAVE & CLOSE
            </button>
          </div>
        </div>
      )}

    </>
  );
}
