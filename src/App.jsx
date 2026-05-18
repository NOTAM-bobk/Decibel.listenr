import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Application State
  const [isRecording, setIsRecording] = useState(false);
  const [permissionError, setPermissionError] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
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

  // Refs for Web Audio & APIs
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const filterRef = useRef(null); 
  const streamRef = useRef(null);
  const animationFrameRef = useRef(null);
  const wakeLockRef = useRef(null);

  // Accumulators for calculating Average & History
  const runningSumRef = useRef(0);
  const countRef = useRef(0);
  const MAX_HISTORY = 500;
  const rollingHistoryBuffer = useRef(Array(MAX_HISTORY).fill(0));

  // Visualizer Canvas Refs
  const graphCanvasRef = useRef(null);
  const scrollContainerRef = useRef(null);

  // Helper to determine color based on dB level
  const getDbColor = (db) => {
    if (db < 60) return '#4ade80'; // Bright Green (Safe)
    if (db < 85) return '#fde047'; // Bright Yellow (Warning)
    return '#f43f5e'; // Bright Rose/Red (Danger)
  };

  const currentColor = getDbColor(currentDb);

  // Helper to determine funny messages
  const getFunnyMessage = (db) => {
    if (db === 0 && !isRecording) return "Press START to listen! 🎙️";
    if (db < 30) return "Quiet as a ninja mouse. 🥷🐁";
    if (db < 50) return "Just chillin' in the library. 📚☕";
    if (db < 70) return "Normal human chatter. 🗣️";
    if (db < 85) return "Things are getting spicy! 🌶️";
    if (db < 100) return "RIP headphone users! 🎧💥";
    if (db < 115) return "Are you at a rock concert?! 🎸🤘";
    return "CALL AN AMBULANCE FOR YOUR EARS! 🚑🙉";
  };

  // Handle Online/Offline Status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Apply filter weighting dynamically when settings change
  useEffect(() => {
    if (filterRef.current) {
      if (weighting === 'A') {
        filterRef.current.type = 'highpass';
        filterRef.current.frequency.value = 500; 
      } else if (weighting === 'C') {
        filterRef.current.type = 'highpass';
        filterRef.current.frequency.value = 30; 
      } else {
        filterRef.current.type = 'allpass'; 
      }
    }
  }, [weighting]);

  // Request Wake Lock to keep screen awake
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      console.log('Wake Lock denied or unsupported:', err);
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current !== null) {
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  };

  // Initialize Audio
  const startRecording = async () => {
    try {
      setPermissionError(null);
      await requestWakeLock();
      
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
      
      if (weighting === 'A') { filter.type = 'highpass'; filter.frequency.value = 500; } 
      else if (weighting === 'C') { filter.type = 'highpass'; filter.frequency.value = 30; } 
      else { filter.type = 'allpass'; }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512; 
      
      source.connect(filter);
      filter.connect(analyser);
      analyserRef.current = analyser;

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
      rollingHistoryBuffer.current = Array(MAX_HISTORY).fill(0);

      tick();
    } catch (err) {
      console.error(err);
      setPermissionError('Microphone access denied. Please allow microphone permissions in settings.');
    }
  };

  // Stop Audio Processing
  const stopRecording = () => {
    setIsRecording(false);
    releaseWakeLock();
    
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
    const container = scrollContainerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const PIXELS_PER_POINT = 4; // Width of each history slice
    const totalWidth = MAX_HISTORY * PIXELS_PER_POINT;
    
    const dpr = window.devicePixelRatio || 1;
    const height = container.clientHeight;

    // Set fixed physical width to allow scrolling
    canvas.style.width = `${totalWidth}px`;
    canvas.style.height = `${height}px`;
    canvas.width = totalWidth * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, totalWidth, height);

    // Draw Horizontal Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gridSteps = [20, 40, 60, 80, 100, 120].filter(v => v <= displayScale);
    gridSteps.forEach(val => {
      const y = height - (val / displayScale) * height;
      ctx.moveTo(0, y);
      ctx.lineTo(totalWidth, y);
    });
    ctx.stroke();

    const data = rollingHistoryBuffer.current;
    
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#4ade80'); // Safe
    grad.addColorStop(0.65, '#fde047'); // Warn
    grad.addColorStop(1, '#f43f5e'); // Danger
    
    ctx.beginPath();
    
    if (graphType === 'Bar') {
      for (let i = 0; i < data.length; i++) {
        const dbVal = data[i];
        const barHeight = (dbVal / displayScale) * height;
        const x = i * PIXELS_PER_POINT;
        const y = height - barHeight;
        
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, PIXELS_PER_POINT - 1, barHeight);
      }
    } else {
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = grad;

      for (let i = 0; i < data.length; i++) {
        const dbVal = data[i];
        const x = i * PIXELS_PER_POINT;
        const y = height - (dbVal / displayScale) * height;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (graphType === 'Area') {
        ctx.lineTo(totalWidth, height);
        ctx.lineTo(0, height);
        const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
        fillGrad.addColorStop(0, 'rgba(253, 224, 71, 0.3)'); 
        fillGrad.addColorStop(1, 'rgba(74, 222, 128, 0)'); 
        ctx.fillStyle = fillGrad;
        ctx.fill();
      }
    }

    // Auto-scroll logic: only snap to the end if the user hasn't scrolled manually far back
    const isAtEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - 50;
    if (isAtEnd) {
      container.scrollLeft = container.scrollWidth;
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
      <style>{`
        /* 3D Spotlight Background Animations */
        @keyframes spotlight3d {
          0% { transform: perspective(800px) translate3d(-30%, -30%, -100px) rotateX(20deg); opacity: 0.5; }
          50% { transform: perspective(800px) translate3d(30%, 20%, 50px) rotateY(-20deg); opacity: 0.7; }
          100% { transform: perspective(800px) translate3d(-30%, -30%, -100px) rotateX(20deg); opacity: 0.5; }
        }
        @keyframes spotlight3d-alt {
          0% { transform: perspective(800px) translate3d(20%, 40%, 100px) rotateZ(15deg); opacity: 0.4; }
          50% { transform: perspective(800px) translate3d(-40%, -10%, -50px) rotateZ(-15deg); opacity: 0.6; }
          100% { transform: perspective(800px) translate3d(20%, 40%, 100px) rotateZ(15deg); opacity: 0.4; }
        }
        .animate-spotlight-1 { animation: spotlight3d 12s infinite ease-in-out; }
        .animate-spotlight-2 { animation: spotlight3d-alt 15s infinite ease-in-out reverse; }
        .animate-spotlight-3 { animation: spotlight3d 18s infinite ease-in-out 3s; }
        
        /* Custom Scrollbar for Timeline */
        .custom-scrollbar::-webkit-scrollbar { height: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.5); border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(52, 211, 153, 0.6); border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(52, 211, 153, 0.9); }
      `}</style>

      <div className="relative min-h-screen bg-[#020617] text-white flex flex-col font-sans overflow-x-hidden selection:bg-emerald-500 selection:text-black">
        
        {/* Animated 3D Spotlight Background */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
          <div className="absolute top-[10%] left-[10%] w-[50vw] h-[50vw] bg-emerald-500/30 rounded-full blur-[120px] animate-spotlight-1"></div>
          <div className="absolute bottom-[20%] right-[10%] w-[60vw] h-[60vw] bg-rose-500/20 rounded-full blur-[120px] animate-spotlight-2"></div>
          <div className="absolute top-[40%] right-[40%] w-[40vw] h-[40vw] bg-blue-500/20 rounded-full blur-[100px] animate-spotlight-3"></div>
        </div>

        {/* Navbar (Neo-Brutalist Glassmorphism) */}
        <header className="bg-white/5 backdrop-blur-xl border-b-[3px] border-slate-700 p-4 shadow-[0px_4px_0px_0px_#1e293b] flex flex-wrap items-center justify-between z-10 m-4 rounded-2xl gap-3">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-400 p-2 rounded-xl border-2 border-slate-900 shadow-[2px_2px_0px_0px_#0f172a]">
              <svg className="w-6 h-6 text-slate-900" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h1 className="font-black text-2xl tracking-tighter text-white drop-shadow-md">Decibel.listenr</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`}></span>
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">{isOnline ? 'Online / Ready' : 'Offline Ready'}</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3 ml-auto">
            {/* View Source Button */}
            <a 
              href="https://github.com/NOTAM-bobk/Decibel.listenr/tree/main" 
              target="_blank" 
              rel="noreferrer"
              className="hidden sm:flex items-center gap-2 bg-blue-400 hover:bg-blue-300 text-slate-900 text-xs font-black px-4 py-2.5 rounded-xl border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a] active:translate-y-[2px] active:translate-x-[2px] active:shadow-[1px_1px_0px_0px_#0f172a] transition-all"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"></path></svg>
              SOURCE CODE
            </a>

            {/* Settings Drawer Trigger */}
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="bg-slate-800 hover:bg-slate-700 text-white p-2.5 rounded-xl border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a] active:translate-y-[2px] active:translate-x-[2px] active:shadow-[1px_1px_0px_0px_#0f172a] transition-all flex items-center justify-center"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            </button>
          </div>
        </header>

        {permissionError && (
          <div className="mx-4 bg-rose-500/20 backdrop-blur-md border-2 border-rose-500 p-4 rounded-xl shadow-[4px_4px_0px_0px_#e11d48] font-bold text-rose-100 flex items-start gap-2">
            <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            {permissionError}
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col items-center p-4 max-w-3xl mx-auto w-full z-10 pb-10">
          
          {/* Main Dial (Glass Panel) */}
          <div className="bg-white/5 backdrop-blur-xl border-4 border-slate-700 shadow-[8px_8px_0px_0px_#0f172a] rounded-[2rem] w-full p-8 flex flex-col items-center relative overflow-hidden">
            <div className="relative w-full aspect-[2/1] max-w-[400px]">
              <svg viewBox="0 0 200 110" className="w-full h-full overflow-visible drop-shadow-2xl">
                {/* Background Track */}
                <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke="rgba(51, 65, 85, 0.5)" strokeWidth="18" strokeLinecap="round" />
                {/* Colored Dynamic Fill */}
                <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke={currentColor} strokeWidth="18" strokeLinecap="round" strokeDasharray={gaugeCircumference} strokeDashoffset={dashOffset} className="transition-all duration-100 ease-out" />
              </svg>
              
              <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center translate-y-3">
                <div className="flex items-baseline gap-1" style={{ color: currentColor }}>
                  <span className="text-8xl md:text-9xl font-black tabular-nums tracking-tighter drop-shadow-lg">
                    {Math.round(currentDb)}
                  </span>
                  <span className="text-3xl font-black opacity-90 drop-shadow-md">dB</span>
                </div>
              </div>
            </div>
            {/* Funny Dynamic Message */}
            <div className="mt-8 text-center min-h-[3rem] flex items-center justify-center">
              <span className="text-base md:text-lg font-bold text-slate-200 bg-slate-900/60 px-6 py-2 rounded-2xl border-2 border-slate-700 shadow-inner">
                {getFunnyMessage(currentDb)}
              </span>
            </div>
          </div>

          {/* Stats Row */}
          <div className="w-full grid grid-cols-3 gap-3 md:gap-5 my-6">
            <div className="bg-emerald-500/10 backdrop-blur-xl border-[3px] border-emerald-500 shadow-[4px_4px_0px_0px_#047857] rounded-2xl p-3 md:p-5 flex flex-col items-center justify-center">
              <span className="text-[10px] md:text-xs text-emerald-300 uppercase font-black tracking-widest mb-1">Min</span>
              <span className="text-2xl md:text-3xl font-black tabular-nums text-emerald-50">{minDb === 999 ? '0' : Math.round(minDb)}</span>
            </div>
            <div className="bg-blue-500/10 backdrop-blur-xl border-[3px] border-blue-500 shadow-[4px_4px_0px_0px_#1d4ed8] rounded-2xl p-3 md:p-5 flex flex-col items-center justify-center">
              <span className="text-[10px] md:text-xs text-blue-300 uppercase font-black tracking-widest mb-1">Avg</span>
              <span className="text-2xl md:text-3xl font-black tabular-nums text-blue-50">{Math.round(avgDb)}</span>
            </div>
            <div className="bg-rose-500/10 backdrop-blur-xl border-[3px] border-rose-500 shadow-[4px_4px_0px_0px_#be123c] rounded-2xl p-3 md:p-5 flex flex-col items-center justify-center">
              <span className="text-[10px] md:text-xs text-rose-300 uppercase font-black tracking-widest mb-1">Max</span>
              <span className="text-2xl md:text-3xl font-black tabular-nums text-rose-50">{Math.round(maxDb)}</span>
            </div>
          </div>

          {/* Primary Controls */}
          <div className="mb-6 w-full flex flex-col sm:flex-row justify-center gap-4">
            {!isRecording ? (
              <button 
                onClick={startRecording} 
                className="flex-1 w-full mx-auto py-5 px-6 rounded-[2rem] bg-emerald-400 border-[3px] border-slate-900 text-slate-950 font-black text-xl md:text-2xl shadow-[6px_6px_0px_0px_#047857] active:translate-y-[6px] active:translate-x-[6px] active:shadow-[0px_0px_0px_0px_#047857] transition-all flex items-center justify-center gap-3"
              >
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                START LISTENING
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row w-full gap-4">
                <button onClick={stopRecording} className="flex-1 py-4 rounded-2xl bg-slate-800 border-4 border-slate-900 text-slate-300 font-black text-xl shadow-[4px_4px_0px_0px_#0f172a] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#0f172a] transition-all flex items-center justify-center gap-2">
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
                  STOP
                </button>
                <button onClick={resetStats} className="py-4 px-6 rounded-2xl bg-blue-400 border-4 border-slate-900 text-slate-900 shadow-[4px_4px_0px_0px_#1d4ed8] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#1d4ed8] transition-all flex items-center justify-center font-bold">
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
                {/* Audio Recording Toggle */}
                {mediaRecorder && (
                  <button onClick={toggleAudioRecording} className={`flex-[1.5] py-4 rounded-2xl border-4 border-slate-900 font-black text-xl shadow-[4px_4px_0px_0px_#9f1239] active:translate-y-[4px] active:translate-x-[4px] active:shadow-[0px_0px_0px_0px_#9f1239] transition-all flex items-center justify-center gap-3 ${isRecordingAudio ? 'bg-rose-500 text-white animate-pulse' : 'bg-rose-400 text-slate-900'}`}>
                    <div className={`w-5 h-5 rounded-full border-2 border-slate-900 ${isRecordingAudio ? 'bg-white' : 'bg-rose-900'}`}></div>
                    {isRecordingAudio ? 'RECORDING...' : 'REC AUDIO'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Audio Playback & Download Panel */}
          {audioUrl && !isRecordingAudio && (
            <div className="w-full bg-slate-800/90 backdrop-blur-xl border-4 border-emerald-400 shadow-[6px_6px_0px_0px_#047857] p-5 rounded-3xl mb-6 flex flex-col md:flex-row items-center gap-4 justify-between animate-in fade-in slide-in-from-bottom-4">
              <div className="flex-1 w-full bg-slate-900 rounded-xl overflow-hidden border-2 border-slate-700">
                <audio src={audioUrl} controls className="w-full h-12" />
              </div>
              <a 
                href={audioUrl} 
                download="decibel-recording.mp4"
                className="w-full md:w-auto bg-emerald-400 text-slate-900 px-6 py-3 rounded-xl font-black text-lg border-2 border-slate-900 shadow-[3px_3px_0px_0px_#0f172a] hover:translate-y-1 hover:translate-x-1 hover:shadow-none transition-all whitespace-nowrap flex justify-center items-center gap-2"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                DOWNLOAD
              </a>
            </div>
          )}

          {/* Scrollable Real-time Graph (Glass Panel) */}
          <div className="w-full bg-white/5 backdrop-blur-xl rounded-[2rem] border-4 border-slate-700 shadow-[8px_8px_0px_0px_#0f172a] p-5 flex-1 min-h-[260px] flex flex-col">
            <div className="flex justify-between items-center mb-4 px-2">
              <span className="text-base font-black text-white uppercase drop-shadow-md">Scrollable Timeline</span>
              <span className="text-xs font-bold text-slate-300 bg-slate-900/60 px-3 py-1.5 rounded-lg border-2 border-slate-700">0 - {displayScale} dB</span>
            </div>
            
            {/* Horizontally Scrollable Canvas Container */}
            <div 
              ref={scrollContainerRef}
              className="relative flex-1 w-full bg-[#020617]/60 rounded-xl border-2 border-slate-800 overflow-x-auto overflow-y-hidden shadow-inner custom-scrollbar touch-pan-x"
            >
              <canvas ref={graphCanvasRef} className="absolute inset-y-0 left-0 h-full" />
            </div>
          </div>

        </main>
      </div>

      {/* Settings Drawer (Right Side Pull-out) */}
      <div 
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-96 bg-slate-900 border-l-[4px] border-slate-700 shadow-[-10px_0px_30px_rgba(0,0,0,0.5)] transform transition-transform duration-300 ease-in-out flex flex-col ${isSettingsOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="p-6 border-b-2 border-slate-800 flex justify-between items-center bg-slate-950">
          <h2 className="text-2xl font-black text-white">Configurations</h2>
          <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-rose-400 bg-slate-800 hover:bg-slate-700 p-2.5 rounded-xl border-2 border-slate-700 transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          
          {/* Calibration */}
          <div>
            <div className="flex justify-between text-base font-bold text-slate-300 mb-3">
              <label>Calibration Offset</label>
              <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/30">
                {calibrationOffset > 0 ? '+' : ''}{calibrationOffset} dB
              </span>
            </div>
            <input 
              type="range" min="-20" max="20" step="0.5" 
              value={calibrationOffset} 
              onChange={(e) => setCalibrationOffset(e.target.value)}
              className="w-full accent-emerald-400 h-3 bg-slate-800 rounded-lg appearance-none cursor-pointer" 
            />
          </div>

          {/* Update Rate */}
          <div>
            <label className="block text-base font-bold text-slate-300 mb-3">Display Update Rate</label>
            <div className="grid grid-cols-2 gap-3">
              {['Fast', 'Slow'].map(mode => (
                <button key={mode} onClick={() => setUpdateRate(mode)} className={`py-3 font-black rounded-xl border-2 transition-all ${updateRate === mode ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[3px_3px_0px_0px_#10b981]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency Weighting */}
          <div>
            <label className="block text-base font-bold text-slate-300 mb-3">Frequency Weighting</label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { val: 'Z', label: 'Z (Flat)' },
                { val: 'A', label: 'A (Ear)' },
                { val: 'C', label: 'C (Peak)' }
              ].map(mode => (
                <button key={mode.val} onClick={() => setWeighting(mode.val)} className={`py-3 text-sm font-black rounded-xl border-2 transition-all ${weighting === mode.val ? 'bg-blue-500/20 border-blue-500 text-blue-400 shadow-[3px_3px_0px_0px_#3b82f6]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          {/* Graph Type */}
          <div>
            <label className="block text-base font-bold text-slate-300 mb-3">Timeline Graph Style</label>
            <div className="grid grid-cols-3 gap-3">
              {['Area', 'Line', 'Bar'].map(mode => (
                <button key={mode} onClick={() => setGraphType(mode)} className={`py-3 text-sm font-black rounded-xl border-2 transition-all ${graphType === mode ? 'bg-rose-500/20 border-rose-500 text-rose-400 shadow-[3px_3px_0px_0px_#e11d48]' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Display Scale */}
          <div>
            <label className="block text-base font-bold text-slate-300 mb-3">Display Scale Max (dB)</label>
            <select value={displayScale} onChange={(e) => setDisplayScale(Number(e.target.value))} className="w-full bg-slate-800 border-2 border-slate-700 text-white font-bold text-lg rounded-xl p-4 outline-none focus:border-emerald-500 shadow-[4px_4px_0px_0px_#0f172a] appearance-none">
              <option value={100}>100 dB (Standard)</option>
              <option value={130}>130 dB (Extended)</option>
              <option value={160}>160 dB (Extreme)</option>
            </select>
          </div>

        </div>

        {/* Disclaimer Area inside Drawer */}
        <div className="p-6 bg-slate-950 border-t-2 border-slate-800 mt-auto">
          <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
            <strong className="text-slate-400">Disclaimer:</strong> This application utilizes browser-based Web Audio APIs for educational and entertainment purposes. Hardware microphone limitations prevent clinical accuracy. Do not use this tool for formal occupational safety compliance.
          </p>
        </div>
      </div>

      {/* Backdrop for Settings Drawer */}
      {isSettingsOpen && (
        <div 
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm"
          onClick={() => setIsSettingsOpen(false)}
        ></div>
      )}

    </>
  );
}
