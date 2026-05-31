import { motion, AnimatePresence } from "motion/react";
import { Upload, FileText, CheckCircle2, AlertCircle, X, ChevronRight, Target, Globe, Lightbulb, MapPin, Search, List, ArrowLeft, Building2, Save, Trash2, History, LogIn, LogOut, User as UserIcon, Heart, Mail } from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import { cn, BD_INDUSTRIES, Industry, Company } from "./lib/utils";
import { analyzeResume, AnalysisResult } from "./services/geminiService";
import { auth, signInWithGoogle, db } from "./lib/firebase";
import { onAuthStateChanged, User, signOut } from "firebase/auth";
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, deleteDoc, doc, setDoc, getDocFromServer } from "firebase/firestore";
import { handleFirestoreError, OperationType } from "./lib/errorHandlers";

type Mode = "MENU" | "CV_REVIEW" | "COMPANIES";

interface SavedSession {
  id?: string;
  jobDescription: string;
  result: AnalysisResult;
  fileName: string;
  savedAt: any; // Timestamp or string
}

export default function App() {
  /**
   * ==========================================================================
   * CORE STATE MANAGEMENT
   * ==========================================================================
   * mode: Controls the main view (Menu, CV Review, or Companies Directory)
   * file: The raw PDF file uploaded by the user
   * jobDescription: The user's target job requirement text
   * isAnalyzing: Boolean for loading/processing states
   * result: The data returned from the Gemini AI analysis
   * user: The currently authenticated user
   * history: List of saved sessions from Firestore
   * ==========================================================================
   */
  const [mode, setMode] = useState<Mode>("MENU");
  const [inputType, setInputType] = useState<"PDF" | "LINKEDIN">("PDF");
  const [linkedInProfileText, setLinkedInProfileText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [jobDescription, setJobDescription] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [loadingText, setLoadingText] = useState("ACCESSING_AI_CORE...");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isAnalyzing) {
      const texts = [
        "PARSING_RESUME_DATA...",
        "EXTRACTING_KEY_COMPETENCIES...",
        "CROSS_REFERENCING_BD_STANDARDS...",
        "EVALUATING_MARKET_FIT...",
        "GENERATING_ACTIONABLE_INSIGHTS...",
        "FINALIZING_TIER_CLASSIFICATION..."
      ];
      let i = 0;
      setLoadingText(texts[0]);
      interval = setInterval(() => {
        i = (i + 1) % texts.length;
        setLoadingText(texts[i]);
      }, 1500);
    }
    return () => clearInterval(interval);
  }, [isAnalyzing]);
  const [history, setHistory] = useState<SavedSession[]>([]);
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null);
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);
  const [analysisContext, setAnalysisContext] = useState<{
    label: string;
    description: string;
    type: "GENERAL" | "INDUSTRY" | "COMPANY";
  } | null>(null);

  const [contextHistory, setContextHistory] = useState<{
    label: string;
    description: string;
    type: "GENERAL" | "INDUSTRY" | "COMPANY";
  }[]>(() => {
    try {
      const stored = localStorage.getItem("hireKorbeContextHistory");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("hireKorbeContextHistory", JSON.stringify(contextHistory));
  }, [contextHistory]);

  const [showContextHistory, setShowContextHistory] = useState(false);

  // Industry Directory States
  const [selectedIndustry, setSelectedIndustry] = useState<Industry | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  /**
   * ==========================================================================
   * FIREBASE AUTH & FIRESTORE REAL-TIME SYNC
   * ==========================================================================
   */
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Sync user profile to Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDocFromServer(userRef);
        if (!userSnap.exists()) {
          try {
            await setDoc(userRef, {
              userId: currentUser.uid,
              email: currentUser.email,
              displayName: currentUser.displayName,
              createdAt: serverTimestamp()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
          }
        }

        // Sync history
        const historyRef = collection(db, `users/${currentUser.uid}/sessions`);
        const q = query(historyRef, orderBy("createdAt", "desc"));
        return onSnapshot(q, (snapshot) => {
          const sessions = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          })) as SavedSession[];
          setHistory(sessions);
        }, (err) => {
          handleFirestoreError(err, OperationType.LIST, `users/${currentUser.uid}/sessions`);
        });
      } else {
        setHistory([]);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      setError("LOGIN FAILED. PLS TRY AGAIN.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setMode("MENU");
    } catch (err) {
      console.error(err);
    }
  };

  const [optimizationUsage, setOptimizationUsage] = useState<{count: number, date: string}>(() => {
    try {
      const saved = localStorage.getItem("hirekorbe_usage");
      if (saved) {
        const parsed = JSON.parse(saved);
        const today = new Date().toISOString().split("T")[0];
        if (parsed.date === today) {
          return parsed;
        } else {
          return { count: 0, date: today };
        }
      }
    } catch {}
    return { count: 0, date: new Date().toISOString().split("T")[0] };
  });

  const isLimitReached = optimizationUsage.count >= 3;

  /**
   * =========================================================================
   * ANALYSIS ENGINE TRIGGER
   * =========================================================================
   */
  const initiateAnalysis = async () => {
    if (isAnalyzing || isLimitReached) return;
    
    let payload = fileBase64;
    let mimeType = file?.type || "application/pdf";

    if (inputType === "LINKEDIN") {
      if (!linkedInProfileText.trim()) {
        setError("LINKEDIN PROFILE TEXT IS REQUIRED.");
        return;
      }
      payload = linkedInProfileText;
      mimeType = "text/plain";
    } else {
      if (!fileBase64) return;
    }

    if (analysisContext) {
      setContextHistory(prev => {
        if (!prev.find(c => c.label === analysisContext.label)) {
          return [analysisContext, ...prev];
        }
        return prev;
      });
    }

    setIsAnalyzing(true);
    setResult(null);
    setError(null);
    
    abortControllerRef.current = new AbortController();

    try {
      // Combine HR insights if available
      const hrContext = analysisContext 
        ? `${analysisContext.label}: ${analysisContext.description}` 
        : "";

      const data = await analyzeResume(
        payload as string, 
        mimeType, 
        jobDescription, 
        "Bangladesh",
        hrContext
      );
      if (!abortControllerRef.current?.signal.aborted) {
        setResult(data);
        const newUsage = { ...optimizationUsage, count: optimizationUsage.count + 1 };
        setOptimizationUsage(newUsage);
        localStorage.setItem("hirekorbe_usage", JSON.stringify(newUsage));
      }
    } catch (err: any) {
      if (!abortControllerRef.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to analyze resume. Check your API key.");
      }
    } finally {
      if (!abortControllerRef.current?.signal.aborted) {
        setIsAnalyzing(false);
      }
      abortControllerRef.current = null;
    }
  };

  /**
   * ==========================================================================
   * PERSISTENCE HANDLERS (FIREBASE + LOCALSTORAGE FALLBACK)
   * ==========================================================================
   */
  useEffect(() => {
    if (!user) {
      const saved = localStorage.getItem("hirekorbe_cv_session");
      if (saved) {
        try {
          setSavedSession(JSON.parse(saved));
        } catch (err) {
          console.error("Failed to parse saved session", err);
        }
      }
    }
  }, [user]);

  const saveSession = async () => {
    if (!result) return;

    if (user) {
      // Save to Firestore
      const sessionData = {
        userId: user.uid,
        fileName: (file?.name || "UPLOADED_CV.PDF").slice(0, 255),
        jobDescription: jobDescription.trim().slice(0, 15000),
        result,
        createdAt: serverTimestamp()
      };
      try {
        await addDoc(collection(db, `users/${user.uid}/sessions`), sessionData);
        setShowSaveSuccess(true);
        setTimeout(() => setShowSaveSuccess(false), 3000);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/sessions`);
      }
    } else {
      // Fallback: LocalStorage
      const session: SavedSession = {
        jobDescription: jobDescription.trim().slice(0, 15000),
        result,
        fileName: (file?.name || "RECOVERED_SESSION.PDF").slice(0, 255),
        savedAt: new Date().toLocaleString()
      };
      localStorage.setItem("hirekorbe_cv_session", JSON.stringify(session));
      setSavedSession(session);
      setShowSaveSuccess(true);
      setTimeout(() => setShowSaveSuccess(false), 3000);
    }
  };

  const deleteSession = async (id?: string) => {
    if (user && id) {
      try {
        await deleteDoc(doc(db, `users/${user.uid}/sessions`, id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/sessions/${id}`);
      }
    } else {
      localStorage.removeItem("hirekorbe_cv_session");
      setSavedSession(null);
    }
  };

  const loadSavedSession = (session: SavedSession) => {
    setJobDescription(session.jobDescription);
    setResult(session.result);
    setFile(null); 
    setFileBase64(null);
  };

  const resetReview = () => {
    setFile(null);
    setFileBase64(null);
    setLinkedInProfileText("");
    setJobDescription("");
    setResult(null);
    setError(null);
    setAnalysisContext(null);
  };

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.type !== "application/pdf") {
        setError("PDF ONLY PLS.");
        return;
      }
      setFile(selectedFile);
      setError(null);
      
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setFileBase64(base64);
      };
      reader.readAsDataURL(selectedFile);
    }
  }, []);

  const handleStartAnalysis = async () => {
    if (!fileBase64 || !jobDescription) {
      setError("NEED RESUME + JOB DESC.");
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    try {
      const analysis = await analyzeResume(
        fileBase64,
        file!.type,
        jobDescription,
        "Bangladesh"
      );
      setResult(analysis);
    } catch (err) {
      console.error(err);
      setError("ANALYSIS FAILED. OOF.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-deep-bg text-black p-4 md:p-12 selection:bg-black selection:text-white font-sans">
      {/* =====================================================================
          APP HEADER
          ===================================================================== */}
      <header className="max-w-4xl mx-auto mb-16 mt-4 flex items-center justify-between">
        <div className="flex items-center gap-4 md:gap-6">
          <div className="w-12 h-12 md:w-16 md:h-16 bg-black flex items-center justify-center text-white shadow-[4px_4px_0px_0px_#d1d1d6]">
            <Target size={28} className="md:w-8 md:h-8" />
          </div>
          <div>
            <h1 className="text-xl md:text-3xl font-pixel tracking-tighter text-black">HireKorbe?</h1>
            <p className="text-[7px] md:text-[8px] font-sans font-bold text-neutral-400 tracking-[0.2em] mt-2 uppercase">CRACK ANY RECRUITMENT</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="hidden md:block text-right">
                <p className="text-[8px] font-pixel text-black">{user.displayName?.toUpperCase()}</p>
                <p className="text-[6px] font-sans font-bold text-neutral-400 uppercase">AUTHENTICATED_SESSION</p>
              </div>
              <button 
                onClick={handleLogout}
                className="w-10 h-10 bg-black text-white flex items-center justify-center shadow-[3px_3px_0px_0px_#d1d1d6] hover:bg-neutral-800 transition-colors"
                title="LOGOUT"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button 
              onClick={handleLogin}
              className="pixel-btn-secondary flex items-center gap-2"
            >
              <LogIn size={14} /> <span className="hidden md:inline">SYSTEM_LOGIN</span>
            </button>
          )}

          {mode !== "MENU" && (
            <button 
              onClick={() => { setMode("MENU"); resetReview(); setSelectedIndustry(null); setSelectedCompany(null); }}
              className="pixel-btn-secondary"
            >
              <ArrowLeft size={14} /> <span className="hidden md:inline">RETURN_MAIN</span>
            </button>
          )}

          <button 
            onClick={() => setShowContextHistory(true)}
            className="pixel-btn-secondary flex items-center gap-2"
          >
            <History size={14} /> <span className="hidden md:inline">SAVED_CONTEXTS</span>
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto">
        <AnimatePresence mode="wait">
          {mode === "MENU" && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className="grid gap-10 md:grid-cols-2"
            >
              <button 
                onClick={() => setMode("CV_REVIEW")}
                className="pixel-card h-64 md:h-80 flex flex-col items-center justify-center gap-4 md:gap-6 text-center group cursor-pointer hover:bg-slate-50 border-black/10"
              >
                <div className="p-4 md:p-6 bg-black text-white group-hover:scale-110 transition-transform shadow-[4px_4px_0px_0px_#d1d1d6]">
                  <FileText size={48} className="md:w-14 md:h-14" />
                </div>
                <h2 className="text-lg md:text-xl font-pixel tracking-tighter">CV REVIEW</h2>
                <p className="text-[10px] md:text-xs text-neutral-500 max-w-[180px] md:max-w-[200px]">AI-POWERED SCAN FOR BD JOB STANDARDS</p>
              </button>

              <button 
                onClick={() => setMode("COMPANIES")}
                className="pixel-card h-64 md:h-80 flex flex-col items-center justify-center gap-4 md:gap-6 text-center group cursor-pointer hover:bg-slate-50 border-black/10"
              >
                <div className="p-4 md:p-6 bg-black text-white group-hover:scale-110 transition-transform shadow-[4px_4px_0px_0px_#d1d1d6]">
                  <Building2 size={48} className="md:w-14 md:h-14" />
                </div>
                <h2 className="text-lg md:text-xl font-pixel tracking-tighter">BD DIRECTORY</h2>
                <p className="text-[10px] md:text-xs text-neutral-500 max-w-[180px] md:max-w-[200px]">EXPLORE TOP 100+ FIRMS IN BANGLADESH</p>
              </button>
            </motion.div>
          )}

          {/* =====================================================================
              MODE: CV REVIEW ENGINE 
              ===================================================================== */}
          {mode === "CV_REVIEW" && (
            <motion.div
              key="review"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-8"
            >
              {!result ? (
                  <div className="grid md:grid-cols-2 gap-10">
                    <div className="space-y-8">
                      {user && history.length > 0 && (
                        <div className="space-y-4">
                           <h3 className="text-[8px] font-pixel text-neutral-400 uppercase tracking-[0.3em]">SECURE_CLOUD_HISTORY</h3>
                           <div className="grid gap-3">
                              {history.slice(0, 3).map((session) => (
                                <div 
                                  key={session.id}
                                  onClick={() => loadSavedSession(session)}
                                  className="pixel-card border-black bg-neutral-900 text-white cursor-pointer hover:bg-black transition-colors relative group py-4"
                                >
                                  <div className="flex items-center gap-4">
                                    <div className="p-2 bg-white text-black">
                                      <History size={16} />
                                    </div>
                                    <div className="text-left overflow-hidden">
                                       <h3 className="text-[9px] font-pixel text-white truncate w-full">{session.fileName}</h3>
                                       <p className="text-[6px] font-pixel text-neutral-500 mt-1 uppercase">DATA_SYNC_SUCCESS</p>
                                    </div>
                                  </div>
                                  <button 
                                    onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                                    className="absolute top-4 right-4 text-neutral-600 hover:text-bd-red transition-colors"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))}
                           </div>
                        </div>
                      )}

                      {!user && savedSession && !analysisContext && (
                        <div 
                          onClick={() => loadSavedSession(savedSession)}
                          className="pixel-card border-black bg-neutral-900 text-white cursor-pointer hover:bg-black transition-colors relative group"
                        >
                          <div className="flex items-center gap-4">
                            <div className="p-3 bg-white text-black">
                              <History size={20} />
                            </div>
                            <div className="text-left">
                               <h3 className="text-[10px] font-pixel text-white">RESTORE_LAST_SESSION_DETECTED</h3>
                               <p className="text-[7px] font-pixel text-neutral-400 mt-1 uppercase tracking-widest">FILE: {savedSession.fileName}</p>
                            </div>
                          </div>
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteSession(); }}
                            className="absolute top-4 right-4 text-neutral-500 hover:text-bd-red transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}

                      {analysisContext && (
                        <div className="pixel-card bg-white text-black border-2 border-black p-6">
                           <div className="flex items-center gap-4 mb-4">
                              <div className="p-2 bg-black text-white">
                                 <Building2 size={16} />
                              </div>
                              <div>
                                 <h3 className="text-[10px] font-pixel uppercase tracking-tighter text-neutral-400">TARGETED_NODE</h3>
                                 <p className="text-[8px] font-pixel text-black font-bold uppercase">{analysisContext.label}</p>
                              </div>
                           </div>
                           <p className="text-[10px] font-sans font-medium text-black leading-relaxed border-l-2 border-black/20 pl-4 py-1 italic">
                              "{analysisContext.description}"
                           </p>
                           <button 
                             onClick={() => setAnalysisContext(null)}
                             className="text-[8px] font-pixel text-neutral-400 mt-4 hover:text-black transition-colors underline underline-offset-4"
                           >
                             REMOVE_SPECIFIC_CONTEXT
                           </button>
                        </div>
                      )}

                      <div className="pixel-card border-black text-black bg-white">
                        <h3 className="text-xs font-pixel mb-3 text-black">OPTIMIZED FOR LOCAL CORPORATE STANDARD</h3>
                        <p className="text-[10px] leading-6 opacity-80 font-medium">CALIBRATED FOR TOP FIRMS IN DHAKA & CHITTAGONG.</p>
                      </div>

                      <div className="space-y-3 text-left">
                        <label className="pixel-label">JOB SPECIFICATIONS</label>
                        <textarea 
                          className="pixel-input min-h-[220px]"
                          placeholder="PASTE THE JOB CIRCULAR OR ROLE DESCRIPTION HERE..."
                          value={jobDescription}
                          onChange={(e) => setJobDescription(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="space-y-8">
                      <div className="space-y-3 text-left">
                         <div className="flex gap-4 mb-4">
                           <button onClick={() => setInputType("PDF")} className={cn("pixel-btn-secondary text-[8px] flex-1", inputType === "PDF" && "bg-black text-white hover:bg-neutral-800")}>PDF RESUME</button>
                           <button onClick={() => setInputType("LINKEDIN")} className={cn("pixel-btn-secondary text-[8px] flex-1", inputType === "LINKEDIN" && "bg-black text-white hover:bg-neutral-800")}>LINKEDIN PROFILE</button>
                         </div>
                         <label className="pixel-label">{inputType === "PDF" ? "LOAD PDF CV" : "PASTE LINKEDIN PROFILE TEXT"}</label>
                         
                         {inputType === "PDF" ? (
                           <div className="relative pixel-card border-dashed flex flex-col items-center justify-center py-16 bg-slate-50 border-neutral-300">
                              <input type="file" accept=".pdf" onChange={handleFileChange} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                              <Upload size={40} className={cn("transition-colors", file ? "text-black" : "text-slate-400")} />
                              {file ? (
                                <div className="mt-4 flex items-center justify-center gap-2 z-20">
                                  <p className="text-[9px] font-pixel text-black font-bold">{file.name}</p>
                                  <button 
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFile(null); setFileBase64(null); }} 
                                    className="p-1 bg-red-100 text-red-600 hover:bg-red-200 pointer-events-auto"
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                              ) : (
                                <p className="mt-4 text-[9px] font-pixel text-slate-500">DRAG_RESUME_HERE.PDF</p>
                              )}
                           </div>
                         ) : (
                           <div className="relative">
                             <textarea 
                               className="pixel-input min-h-[150px] font-sans text-sm resize-y"
                               placeholder="Paste your full LinkedIn profile text here..."
                               value={linkedInProfileText}
                               onChange={(e) => setLinkedInProfileText(e.target.value)}
                             />
                             {linkedInProfileText && (
                               <button 
                                 onClick={() => setLinkedInProfileText("")}
                                 className="absolute top-2 right-2 p-1 bg-red-100 text-red-600 hover:bg-red-200 z-10"
                               >
                                 <X size={12} />
                               </button>
                             )}
                           </div>
                         )}
                      </div>

                      {error && (
                        <div className="p-4 border-2 border-bd-red text-bd-red text-[7px] font-pixel font-bold animate-pulse leading-5 bg-bd-red/10">
                          FAULT DETECTED: {error}
                        </div>
                      )}

                      {isAnalyzing ? (
                        <button 
                          onClick={() => {
                            if (abortControllerRef.current) {
                              abortControllerRef.current.abort();
                              abortControllerRef.current = null;
                            }
                            setIsAnalyzing(false);
                            setError("SCAN_ABORTED_BY_USER");
                          }}
                          className="pixel-btn bg-red-600 border-red-800 text-white hover:bg-red-700 w-full animate-pulse"
                        >
                          [X] ABORT_SCAN_PROCESS
                        </button>
                      ) : (
                        <div className="space-y-4">
                          <button 
                            disabled={isLimitReached || (inputType === "PDF" ? !file : !linkedInProfileText) || !jobDescription}
                            onClick={initiateAnalysis}
                            className={cn("pixel-btn w-full", isLimitReached && "bg-neutral-300 text-neutral-500 border-neutral-400 cursor-not-allowed hover:bg-neutral-300")}
                          >
                            {isLimitReached ? "DAILY_LIMIT_REACHED" : "INITIATE_FULL_SCAN"}
                          </button>
                          <div className="flex justify-between items-center text-[8px] font-pixel text-neutral-500 uppercase">
                            <span>FREE_TIER_LIMIT: 3/DAY</span>
                            <span className={isLimitReached ? "text-bd-red" : ""}>USED: {optimizationUsage.count}/3</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
              ) : (
                <div className="space-y-8 md:space-y-12">
                  {analysisContext && (
                    <div className="bg-black text-white px-6 py-2 flex items-center justify-between">
                       <span className="text-[8px] font-pixel tracking-widest">CONTEXT_CALIBRATION: {analysisContext.label}</span>
                       <div className="flex gap-2">
                          <div className="w-1 h-1 bg-white animate-ping" />
                          <div className="w-1 h-1 bg-white" />
                       </div>
                    </div>
                  )}
                  <div className="flex flex-col md:flex-row gap-4 text-center md:text-left">
                      <div className="pixel-card bg-white text-black border-black shadow-[4px_4px_0px_0px_#d1d1d6] justify-center flex flex-col shrink-0 min-w-[120px] items-center p-6">
                      <p className="text-[8px] md:text-[10px] font-pixel uppercase tracking-widest text-neutral-500">MATCH</p>
                      <p className="text-2xl md:text-4xl font-pixel mt-3">{result.score}%</p>
                    </div>
                    <div className="pixel-card bg-white text-black border-black shadow-[4px_4px_0px_0px_#d1d1d6] flex-grow flex flex-col justify-center p-6 md:p-8">
                      <p className="text-[8px] font-pixel text-neutral-400 uppercase tracking-widest text-center md:text-left">TIER CLASSIFICATION</p>
                      <p className="text-sm md:text-lg font-sans font-bold text-black mt-3 leading-relaxed text-center md:text-left">{result.marketInsights.standardMatch}</p>
                      {result.marketInsights.candidateStrategy && (
                        <div className="mt-4 pt-4 border-t border-dashed border-neutral-300">
                          <p className="text-[8px] font-pixel text-neutral-500 uppercase tracking-widest mb-2">STRATEGY_TO_DOMINATE_TIER</p>
                          <p className="text-xs font-sans text-neutral-700 leading-relaxed font-medium">
                            {result.marketInsights.candidateStrategy}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="pixel-card text-left bg-white">
                    <h3 className="text-[9px] md:text-xs font-pixel mb-6 border-b-2 border-slate-100 pb-4 text-black underline underline-offset-8">BANGLADESH_MARKET_INSIGHTS</h3>
                    <ul className="grid md:grid-cols-2 gap-x-12 gap-y-6">
                      {result.marketInsights.tips.map((tip, i) => (
                        <li key={i} className="text-[11px] font-medium flex items-start gap-4 leading-6 text-neutral-800">
                          <div className="w-2.5 h-2.5 bg-black shrink-0 mt-1.5 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)]" />
                          {tip}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid md:grid-cols-2 gap-8 md:gap-10 text-left">
                     <div className="pixel-card border-bd-red border-opacity-50">
                        <h3 className="text-[9px] font-pixel mb-4 text-bd-red uppercase tracking-widest">CRITICAL_GAPS</h3>
                        <div className="flex flex-wrap gap-3">
                          {result.keyMissingSkills.map(s => (
                            <span key={s} className="px-3 py-1.5 bg-bd-red/10 border border-bd-red/30 text-bd-red text-[10px] font-bold tracking-tight">{s}</span>
                          ))}
                        </div>
                     </div>
                     <div className="pixel-card border-bd-green border-opacity-50">
                        <h3 className="text-[9px] font-pixel mb-4 text-bd-green uppercase tracking-widest">STRENGTH_NODES</h3>
                        <div className="flex flex-wrap gap-3">
                          {result.resumeStrengths.map(s => (
                            <span key={s} className="px-3 py-1.5 bg-bd-green/10 border border-bd-green/30 text-bd-green text-[10px] font-bold tracking-tight">{s}</span>
                          ))}
                        </div>
                     </div>
                  </div>

                  {result.linkedInSummary && (
                    <div className="pixel-card bg-white border-black text-left relative overflow-hidden group shadow-[4px_4px_0px_0px_#d1d1d6]">
                      <div className="relative z-10 p-6 md:p-8">
                        <div className="flex items-center justify-between border-b border-neutral-200 pb-4 mb-6">
                           <h3 className="text-[10px] md:text-xs font-pixel text-[#0a66c2] uppercase tracking-widest flex items-center gap-3">
                             <span className="bg-[#0a66c2] text-white p-1 rounded-sm">in</span>
                             LINKEDIN_ABOUT_PROTOCOL
                           </h3>
                           <button 
                             onClick={() => {
                               navigator.clipboard.writeText(result.linkedInSummary);
                               alert("LINKEDIN SUMMARY COPIED TO CLIPBOARD.");
                             }}
                             className="pixel-btn-secondary text-[8px] bg-neutral-100 text-black border-neutral-300 hover:bg-neutral-200 py-1.5"
                           >
                             COPY_TO_CLIPBOARD
                           </button>
                        </div>
                        
                        <p className="font-sans text-sm md:text-base text-black leading-relaxed whitespace-pre-wrap font-medium border-l-4 border-[#0a66c2] pl-4">
                          {result.linkedInSummary}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col md:flex-row gap-4">
                    <button 
                      onClick={resetReview}
                      className="pixel-btn-secondary flex-1"
                    >
                      RESET_SCN_ENGINE
                    </button>
                    <button 
                      onClick={saveSession}
                      className={cn(
                        "pixel-btn flex-1 flex items-center justify-center gap-3 transition-all",
                        showSaveSuccess && "bg-bd-green border-bd-green text-white"
                      )}
                    >
                      {showSaveSuccess ? (
                        <>
                          <CheckCircle2 size={16} /> {user ? "CLOUD_SYNCED" : "SESSION_SAVED"}
                        </>
                      ) : (
                        <>
                          <Save size={16} /> {user ? "SYNC_TO_CLOUD" : "SAVE_LOCAL_RECORD"}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* =====================================================================
              MODE: COMPANY DIRECTORY
              ===================================================================== */}
          {mode === "COMPANIES" && (
            <motion.div
              key="companies"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8"
            >
              {analysisContext && (
                <div className="bg-black text-white px-6 py-3 flex items-center justify-between border-2 border-dashed border-neutral-600 mb-6">
                   <span className="text-[10px] font-pixel tracking-widest uppercase">ACTIVE_CONTEXT: {analysisContext.label}</span>
                   <button 
                     onClick={() => setAnalysisContext(null)}
                     className="text-[8px] font-pixel bg-red-600 px-3 py-1 hover:bg-red-700 uppercase"
                   >
                     CLEAR
                   </button>
                </div>
              )}
              <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
                <button 
                  onClick={() => {
                    if (selectedCompany) {
                      setSelectedCompany(null);
                    } else if (searchQuery) {
                      setSearchQuery("");
                    } else if (selectedIndustry) {
                      setSelectedIndustry(null);
                    } else {
                      setMode("MENU");
                    }
                  }}
                  className="flex items-center gap-2 text-black font-pixel text-[8px] uppercase hover:opacity-70 self-start"
                >
                  <ArrowLeft size={14} /> BACK_TO_{selectedCompany ? (searchQuery ? "SEARCH" : "INDUSTRY") : (selectedIndustry || searchQuery) ? "INDEX" : "MENU"}
                </button>

                <div className="relative w-full md:max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={14} />
                  <input
                    type="text"
                    placeholder="SEARCH_FIRMS..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-white border-2 border-black p-2 pl-10 font-pixel text-[8px] focus:outline-none focus:ring-2 focus:ring-black/5"
                  />
                </div>
              </div>

              {selectedCompany ? (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="space-y-8"
                >
                  <div className="pixel-card bg-white border-black text-black p-8 md:p-12 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-5">
                      <Building2 size={120} />
                    </div>
                    <div className="relative z-10">
                       <div className="flex items-center gap-4 mb-6">
                          <div className="w-12 h-12 bg-black text-white flex items-center justify-center font-pixel text-lg">
                            {selectedCompany.name[0]}
                          </div>
                          <div>
                            <h2 className="text-2xl md:text-4xl font-pixel tracking-tighter text-black uppercase">{selectedCompany.name}</h2>
                            <p className="text-[10px] font-pixel text-neutral-500 mt-2 tracking-widest uppercase">{selectedCompany.type}</p>
                          </div>
                       </div>
                       <div className="max-w-2xl border-l-4 border-black pl-6 py-2">
                          <p className="text-sm md:text-base font-medium leading-relaxed text-black italic">
                            "{selectedCompany.summary}"
                          </p>
                       </div>
                    </div>
                  </div>

                  <div className="pixel-card bg-white text-black">
                     <h3 className="text-xs font-pixel mb-8 border-b-2 border-slate-100 pb-4 flex items-center gap-3 text-black">
                       <List size={16} /> 
                       DESIGNATIONS_&_EXPECTED_COMPENSATION
                     </h3>
                       <div className="space-y-4">
                       {selectedCompany.designations.map((d, i) => (
                         <div key={i} className="flex flex-col md:flex-row md:items-center justify-between p-4 bg-slate-50 border-l-4 border-black group hover:bg-neutral-100 transition-colors">
                           <span className="font-pixel text-[10px] uppercase text-black">{d.title}</span>
                           <span className="font-sans font-black text-sm text-neutral-600 mt-2 md:mt-0">{d.salaryScale}</span>
                         </div>
                       ))}
                     </div>
                  </div>

                  <div className="pixel-card bg-neutral-50 border-dashed border-neutral-300">
                    <div className="flex items-center gap-4 mb-6">
                      <div className="p-3 bg-black text-white">
                        <Lightbulb size={24} />
                      </div>
                      <h3 className="font-pixel text-[10px] uppercase tracking-tighter">PRE_HIRE_PROTOCOL: {selectedCompany.name}</h3>
                    </div>
                    <p className="text-xs font-sans font-medium text-neutral-600 leading-relaxed">
                      To pass the initial screening at {selectedCompany.name}, ensure your CV highlights specific experience in {selectedCompany.type}. HR data suggests a focus on local context and problem-solving skills is highly valued.
                    </p>
                    {selectedCompany.hrInsights ? (
                      <button 
                        onClick={() => {
                          const newContext = {
                            label: `COMPANY: ${selectedCompany.name}`,
                            description: selectedCompany.hrInsights!, // Only use HR data
                            type: "COMPANY" as const
                          };
                          setAnalysisContext(newContext);
                          setMode("CV_REVIEW");
                        }}
                        className="pixel-btn-secondary mt-6 w-full text-[8px]"
                      >
                        OPTIMIZE_CV_FOR_{selectedCompany.name}
                      </button>
                    ) : (
                      <button 
                        disabled 
                        className="pixel-btn text-neutral-400 bg-neutral-200 border-neutral-400 mt-6 w-full text-[8px] cursor-not-allowed hover:bg-neutral-200 hover:text-neutral-400 hover:border-neutral-400 opacity-70"
                      >
                        HR_DATA_COMING_SOON
                      </button>
                    )}
                  </div>

                  <button 
                    onClick={() => setSelectedCompany(null)}
                    className="pixel-btn w-full"
                  >
                    BACK_TO_{searchQuery ? "SEARCH" : "LIST"}
                  </button>
                </motion.div>
              ) : searchQuery ? (
                <div className="space-y-6">
                  <div className="pixel-card bg-black text-white border-none">
                    <h2 className="text-lg md:text-xl font-pixel uppercase tracking-tighter">SEARCH_RESULTS</h2>
                    <p className="text-[7px] font-pixel text-slate-400 tracking-[0.4em] mt-3 uppercase">FILTERING: {searchQuery}</p>
                  </div>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {BD_INDUSTRIES.flatMap(ind => ind.companies)
                      .filter(comp => comp.name.toLowerCase().includes(searchQuery.toLowerCase()))
                      .map((company, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setSelectedCompany(company);
                          }}
                          className="pixel-card group hover:border-black transition-all p-6 text-left flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex justify-between items-start mb-4">
                              <h3 className="font-pixel text-[10px] uppercase text-black leading-tight">{company.name}</h3>
                              <div className="p-1.5 bg-slate-100 text-black">
                                <Building2 size={12} />
                              </div>
                            </div>
                            <p className="text-[9px] font-medium text-neutral-500 line-clamp-2 italic">"{company.summary}"</p>
                          </div>
                          <div className="mt-6 flex items-center justify-between">
                            <span className="text-[7px] font-pixel text-neutral-400 uppercase tracking-widest">{company.type}</span>
                            <ChevronRight size={14} className="group-hover:translate-x-1 transition-transform" />
                          </div>
                        </button>
                      ))}
                    {BD_INDUSTRIES.flatMap(ind => ind.companies).filter(comp => comp.name.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
                      <div className="col-span-full py-12 text-center opacity-50">
                        <p className="font-pixel text-[10px] uppercase">NO_TARGETS_FOUND.EXE</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : !selectedIndustry ? (
                  <div className="grid gap-4 md:gap-6">
                  <div className="pixel-card bg-black text-white mb-8 border-none">
                    <h2 className="text-lg md:text-xl font-pixel uppercase tracking-tighter">INDUSTRY_INDEX_BD</h2>
                    <p className="text-[7px] font-pixel text-slate-400 tracking-[0.4em] mt-3 uppercase">TARGET_NODES_AVAILABLE</p>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4 md:gap-6">
                    {BD_INDUSTRIES.map(industry => (
                      <button 
                        key={industry.name}
                        onClick={() => setSelectedIndustry(industry)}
                        className="pixel-card flex items-center justify-between group hover:border-black transition-all p-5 md:p-6"
                      >
                        <span className="font-pixel text-[8px] md:text-[9px] uppercase tracking-normal text-left text-black">{industry.name}</span>
                        <ChevronRight className="group-hover:translate-x-2 transition-transform text-black" size={18} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-6 md:space-y-8">
                  <div className="pixel-card bg-black text-white border-none mb-10 p-6 md:p-10">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 md:gap-8">
                      <div>
                        <h2 className="text-xl md:text-2xl font-pixel tracking-tighter">{selectedIndustry.name}</h2>
                        <p className="text-[8px] font-sans font-extrabold tracking-widest mt-3 uppercase text-slate-300">TOTAL_RECORDS: {selectedIndustry.companies.length}</p>
                      </div>
                      <button 
                        onClick={() => setSelectedIndustry(null)}
                        className="pixel-btn-secondary"
                      >
                        BACK_TO_INDEX
                      </button>
                    </div>
                  </div>

                  <div className="pixel-card bg-white border-2 border-black/5 p-6 mb-10 overflow-hidden relative">
                    <div className="flex flex-col md:flex-row gap-8 items-center bg-black text-white p-8 -m-6 mb-6">
                      <div className="p-4 bg-white text-black shadow-[4px_4px_0px_0px_#8e8e93]">
                        <Search size={32} />
                      </div>
                      <div className="text-left flex-1">
                        <h3 className="text-lg md:text-xl font-pixel tracking-tighter mb-2">CV_OPTIMIZER: {selectedIndustry.name}</h3>
                        <p className="text-[9px] font-sans font-bold text-neutral-400 uppercase tracking-widest leading-relaxed">
                          AI-DRIVEN SCANNER ADJUSTED FOR {selectedIndustry.name.toUpperCase()} RECRUITMENT NODES IN BANGLADESH.
                        </p>
                      </div>
                      <button 
                         onClick={() => {
                           const newContext = {
                             label: `INDUSTRY: ${selectedIndustry.name}`,
                             description: `${selectedIndustry.industryContext || "General industry standards"}`,
                             type: "INDUSTRY" as const
                           };
                           setAnalysisContext(newContext);
                           setMode("CV_REVIEW");
                         }}
                         className="pixel-btn bg-white text-black hover:bg-neutral-100 border-none w-full md:w-auto text-[8px] px-8"
                      >
                         OPTIMIZE_CV_FOR_INDUSTRY
                      </button>
                    </div>
                    
                    <div className="grid md:grid-cols-2 gap-6 text-left">
                       <div className="space-y-4">
                          <h4 className="font-pixel text-[8px] text-neutral-500 uppercase tracking-widest flex items-center gap-2">
                             <div className="w-2 h-2 bg-black" /> HR_DATA_METRICS
                          </h4>
                          <p className="text-xs text-neutral-600 font-medium leading-relaxed">
                             Recruiters in the {selectedIndustry.name} sector prioritize quantifiable achievements and structural clarity. Our engine is being calibrated with real-world feedback from top BD HR managers.
                          </p>
                       </div>
                       <div className="bg-slate-50 p-6 border-l-4 border-black">
                         <h4 className="font-pixel text-[7px] text-black mb-3 uppercase">CALIBRATION_STATUS</h4>
                         <div className="flex items-center gap-3">
                            <div className="h-2 flex-1 bg-neutral-200">
                               <motion.div 
                                 initial={{ width: 0 }}
                                 animate={{ width: "85%" }}
                                 transition={{ duration: 1 }}
                                 className="h-full bg-black" 
                               />
                            </div>
                            <span className="text-[10px] font-pixel">85%</span>
                         </div>
                         <p className="text-[8px] font-sans font-bold text-neutral-400 mt-4 uppercase">STABILIZING_SUBSET_FOR_LOCAL_Hiring</p>
                       </div>
                    </div>
                  </div>
                  
                  <div className="grid gap-6 md:gap-8 md:grid-cols-2 text-left">
                    {selectedIndustry.companies.map(company => (
                      <button 
                        key={company.name} 
                        onClick={() => setSelectedCompany(company)}
                        className="pixel-card border-black/10 hover:border-black group p-6 md:p-10 bg-white text-left block w-full"
                      >
                        <div className="flex items-center gap-4 md:gap-5 mb-8">
                          <div className="w-10 h-10 md:w-14 md:h-14 bg-black text-white flex items-center justify-center shadow-[4px_4px_0px_0px_#d1d1d6]">
                            <Building2 size={24} className="md:w-6 md:h-6" />
                          </div>
                          <h4 className="font-pixel text-[10px] md:text-[12px] tracking-tight text-black">{company.name}</h4>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="inline-flex items-center gap-3 bg-slate-50 px-3 py-1.5 md:px-4 md:py-2 rounded-sm border border-slate-200">
                            <div className="w-1.5 h-1.5 bg-black animate-pulse" />
                            <p className="text-[10px] md:text-xs font-semibold uppercase text-neutral-600">
                              {company.type}
                            </p>
                          </div>
                          <ChevronRight className="text-neutral-300 group-hover:text-black group-hover:translate-x-1 transition-all" size={20} />
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="pixel-card border-dashed bg-slate-50 text-center py-8">
                     <p className="text-[8px] text-neutral-400 font-bold uppercase leading-relaxed tracking-widest">! OPTIMIZE CV FOR THESE NODES FOR MAX MATCH RATE !</p>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="max-w-4xl mx-auto mt-20 md:mt-32 border-t-4 border-slate-100 pt-10 pb-16 md:pb-20 space-y-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8 md:gap-12 opacity-80">
          <div className="flex items-center gap-4 text-left">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-black text-white flex items-center justify-center shadow-[3px_3px_0px_0px_#d1d1d6]">
              <Target size={20} className="md:w-6 md:h-6" />
            </div>
            <div>
              <p className="font-pixel text-[8px] md:text-[10px] tracking-tighter">HireKorbe?</p>
              <p className="font-sans text-[7px] md:text-[8px] font-bold text-neutral-400 mt-1 uppercase tracking-widest text-center md:text-left">CRACK ANY RECRUITMENT</p>
            </div>
          </div>
          <p className="text-[6px] md:text-[7px] font-pixel font-bold uppercase tracking-[0.4em] text-neutral-300 text-center">CREATED BY NARDS</p>
          <div className="flex gap-4 md:gap-6">
            <div className="w-5 h-5 md:w-6 md:h-6 bg-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)]" />
            <div className="w-5 h-5 md:w-6 md:h-6 bg-neutral-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)]" />
            <div className="w-5 h-5 md:w-6 md:h-6 bg-neutral-200 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)]" />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-8 border-t-2 border-slate-50 pt-8 opacity-90">
           <div className="pixel-card bg-slate-50 border-none p-6">
              <div className="flex items-center gap-3 mb-3">
                 <Heart size={14} className="text-bd-red animate-pulse" />
                 <h4 className="font-pixel text-[8px] uppercase">Support_Our_Mission</h4>
              </div>
              <p className="text-[10px] font-sans font-medium text-neutral-600 leading-relaxed mb-4">
                 If this tool helped you secure a node in the BD job market, consider supporting our servers. Every bit helps us keep the AI engine running for everyone.
              </p>
              <button 
                onClick={() => alert("DONATION_CHANNEL:\nbKash / Nagad: +8801XXXXXXXXX\nThank you for supporting HireKorbe?")}
                className="pixel-btn-secondary text-[8px] w-full py-2 uppercase"
              >
                DONATE_VIA_BKASH/NAGAD
              </button>
           </div>
           
           <div className="pixel-card bg-slate-50 border-none p-6">
              <div className="flex items-center gap-3 mb-3">
                 <Mail size={14} className="text-black" />
                 <h4 className="font-pixel text-[8px] uppercase">Contact_Us</h4>
              </div>
              <p className="text-[10px] font-sans font-medium text-neutral-600 leading-relaxed mb-4">
                 Have feedback or need custom recruitment solutions? Our team is active in the Dhaka tech circuit. Reach out to us directly.
              </p>
              <div className="flex gap-2">
                 <a 
                   href="mailto:morsalinrafi03@gmail.com"
                   className="pixel-btn text-[8px] flex-1 py-2 text-center"
                 >
                   EMAIL_US
                 </a>
                 <a 
                   href="https://www.linkedin.com/" 
                   target="_blank" 
                   rel="noopener noreferrer"
                   className="pixel-btn-secondary text-[8px] flex-1 py-2 text-center"
                 >
                   LINKEDIN
                 </a>
              </div>
           </div>
        </div>
      </footer>

      {/* CONTEXT HISTORY MODAL */}
      <AnimatePresence>
        {showContextHistory && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 md:p-8"
          >
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              className="pixel-card bg-white text-black w-full max-w-2xl max-h-[80vh] overflow-y-auto"
            >
              <div className="sticky top-0 bg-white z-10 pb-4 mb-4 border-b-2 border-black flex items-center justify-between">
                <h2 className="font-pixel text-lg md:text-xl uppercase">SAVED_CONTEXTS</h2>
                <button 
                  onClick={() => setShowContextHistory(false)}
                  className="p-2 bg-neutral-100 hover:bg-neutral-200 text-black border-2 border-transparent hover:border-black transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {contextHistory.length === 0 ? (
                <div className="py-12 text-center text-neutral-400">
                  <History size={48} className="mx-auto mb-4 opacity-50" />
                  <p className="font-pixel text-[10px] uppercase">NO_CONTEXT_HISTORY</p>
                  <p className="font-sans text-xs mt-2">Save industry or company contexts to see them here.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {contextHistory.map((ctx, i) => (
                    <div key={i} className="pixel-card bg-slate-50 border-black p-4 md:p-6 group flex flex-col md:flex-row md:items-center justify-between gap-4 transition-colors hover:bg-slate-100">
                      <div>
                        <p className="text-[10px] font-pixel text-black font-bold uppercase mb-2">
                          {ctx.label}
                        </p>
                        <p className="text-[10px] font-sans font-medium text-black leading-relaxed italic line-clamp-2">
                          "{ctx.description}"
                        </p>
                      </div>
                      <div className="flex flex-row md:flex-col gap-2 shrink-0">
                        <button 
                          onClick={() => {
                            setAnalysisContext(ctx);
                            setShowContextHistory(false);
                            setMode("CV_REVIEW");
                          }}
                          className="pixel-btn bg-black text-white hover:bg-neutral-800 text-[8px] py-2 px-3 flex-1 md:flex-none border-none shadow-none"
                        >
                          ACTIVATE
                        </button>
                        <button 
                          onClick={() => setContextHistory(prev => prev.filter(c => c.label !== ctx.label))}
                          className="pixel-btn-secondary bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 hover:border-red-600 text-[8px] py-2 px-3 flex-1 md:flex-none"
                        >
                          DELETE
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
