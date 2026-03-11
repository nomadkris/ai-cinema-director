import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, Image as ImageIcon, Download, Settings, Play, CheckCircle, AlertCircle, FileText, Loader2, ExternalLink, RefreshCw, Quote, Palette, Video, Sparkles, Home, Users, Maximize, RotateCcw } from 'lucide-react';

const App = () => {
  // --- 상태 관리 (State Management) ---
  const [apiKey, setApiKey] = useState('');
  const [availableAnalysisModels, setAvailableAnalysisModels] = useState([]);
  const [availableImageModels, setAvailableImageModels] = useState([]);
  const [analysisModel, setAnalysisModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  
  const [imageCount, setImageCount] = useState(10);
  const [script, setScript] = useState('');
  const [referenceBase64, setReferenceBase64] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  
  const [status, setStatus] = useState('idle'); 
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [segments, setSegments] = useState([]); 
  const [error, setError] = useState(null);
  const [loadingProgress, setLoadingProgress] = useState(0);

  const fileInputRef = useRef(null);

  // 사용자 메모리 기반 스타일 고정 키워드
  const STYLE_PROMPT_SUFFIX = ", simple 2D minimalist line art illustration, Korean webtoon style, round white character with dot eyes, no hair, minimalist environment, warm ivory and light yellow background, flat colors, no text, no letters, cinematic 16:9 widescreen, masterpiece quality";

  // --- 모델 목록 가져오기 ---
  const fetchModels = async () => {
    if (!apiKey) {
      setError('모델을 불러오려면 API 키를 먼저 입력해주세요.');
      return;
    }
    setIsFetchingModels(true);
    setError(null);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || 'API 키가 유효하지 않거나 모델 목록을 가져올 수 없습니다.');
      }
      const data = await response.json();
      const allModels = data.models || [];
      
      const analysisFiltered = allModels.filter(m => 
        m.supportedGenerationMethods.includes('generateContent') && 
        (m.name.includes('gemini-1.5') || m.name.includes('gemini-2.0') || m.name.includes('gemini-2.5'))
      );

      const imageFiltered = allModels.filter(m => 
        m.name.includes('imagen') || m.name.includes('image-preview')
      );

      setAvailableAnalysisModels(analysisFiltered);
      setAvailableImageModels(imageFiltered);

      if (analysisFiltered.length > 0) setAnalysisModel(analysisFiltered[0].name.split('/').pop());
      if (imageFiltered.length > 0) setImageModel(imageFiltered[0].name.split('/').pop());
    } catch (err) {
      setError(String(err.message || '알 수 없는 오류가 발생했습니다.'));
    } finally {
      setIsFetchingModels(false);
    }
  };

  const fetchWithRetry = async (url, options, retries = 3, backoff = 1000) => {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 429 || errorData.error?.message?.includes('quota')) {
          throw new Error('API 할당량을 초과했습니다. 잠시 후 시도하거나 모델을 변경해 보세요.');
        }
        throw new Error(errorData.error?.message || `API Error (${response.status})`);
      }
      return response;
    } catch (err) {
      if (err.message.includes('할당량')) throw err;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
      }
      throw err;
    }
  };

  const handleFile = (file) => {
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => setReferenceBase64(e.target.result.split(',')[1]);
      reader.readAsDataURL(file);
    }
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  // --- 실시간 업데이트를 위한 순차적 분석 로직 ---
  const generatePromptsSequentially = async () => {
    if (!apiKey || !analysisModel) {
      setError('API 키 입력 및 모델 선택이 필요합니다.');
      return;
    }
    if (!script.trim()) {
      setError('대본을 입력해주세요.');
      return;
    }

    setStatus('analyzing');
    setError(null);
    setLoadingProgress(0);
    setSegments([]);

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${analysisModel}:generateContent?key=${apiKey}`;
      
      // Phase 1: Segmentation (구획 나누기)
      setLoadingProgress(5);
      const splitPrompt = `당신은 영상 감독입니다. 제공된 대본을 정확히 ${imageCount}개의 논리적인 구획으로 나누세요.
각 구획에 대해 JSON 배열을 반환하세요:
[{"scene_no": 1, "start_sentence": "...", "end_sentence": "...", "summary": "해당 구획의 짧은 내용 요약"}]
순수한 JSON 배열만 출력하세요.`;

      const splitResponse = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `대본: ${script}` }] }],
          systemInstruction: { parts: [{ text: splitPrompt }] },
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        })
      });

      const splitData = await splitResponse.json();
      const initialSegments = JSON.parse(splitData.candidates[0].content.parts[0].text);
      
      // 초기 세그먼트 상태 설정 (화면에 즉시 틀 노출)
      setSegments(initialSegments.map(s => ({ ...s, prompt: '', video_prompt: '', status: 'analyzing', imageUrl: null })));
      setLoadingProgress(10);

      // Phase 2: Sequential Prompt Generation (각 구획별 프롬프트 생성)
      const currentSegments = [...initialSegments];
      
      for (let i = 0; i < currentSegments.length; i++) {
        const sceneInfo = currentSegments[i];
        const detailPrompt = `이 장면(요약: ${sceneInfo.summary})에 대한 상세 이미지 프롬프트와 비디오 모션 프롬프트를 작성하세요.
[캐릭터 & 스타일 가이드]
주인공: 하얗고 둥근 머리, 점눈, 미니멀한 한국 웹툰 캐릭터.
배경: 아이보리/노란색 톤 배경, 단순한 선화 장소 묘사.
비율: 16:9 와이드.
출력 형식 JSON: {"prompt": "상세 영어 이미지 프롬프트", "video_prompt": "상세 영어 비디오 모션 프롬프트"}
*레퍼런스 이미지의 특징을 반영할 것.*`;

        const contents = [{ role: "user", parts: [{ text: detailPrompt }] }];
        if (referenceBase64) {
          contents[0].parts.push({ inlineData: { mimeType: "image/png", data: referenceBase64 } });
        }

        const detailResponse = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { responseMimeType: "application/json", temperature: 0.3 }
          })
        });

        const detailData = await detailResponse.json();
        const details = JSON.parse(detailData.candidates[0].content.parts[0].text);

        // 상태 업데이트 (장면마다 하나씩 채워짐)
        setSegments(prev => {
          const newSegments = [...prev];
          newSegments[i] = {
            ...newSegments[i],
            prompt: details.prompt,
            video_prompt: details.video_prompt,
            status: 'ready'
          };
          return newSegments;
        });

        const progressVal = 10 + Math.round(((i + 1) / currentSegments.length) * 90);
        setLoadingProgress(progressVal);
        
        // API 속도 제한 방지
        await new Promise(r => setTimeout(r, 300));
      }

      setStatus('prompt-generated');
    } catch (err) {
      setError(String(err.message || '분석 중 오류 발생'));
      setStatus('idle');
    }
  };

  // --- 2단계: 이미지 개별/일괄 생성 로직 ---
  const generateSingleImage = async (index) => {
    const updatedSegments = [...segments];
    updatedSegments[index].status = 'generating';
    setSegments([...updatedSegments]);

    try {
      const finalPrompt = `${updatedSegments[index].prompt}${STYLE_PROMPT_SUFFIX}`;
      let imageUrl = '';

      if (imageModel.toLowerCase().includes('imagen')) {
        const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:predict?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt: finalPrompt }],
            parameters: { sampleCount: 1, aspectRatio: "16:9" }
          })
        });
        const result = await response.json();
        imageUrl = `data:image/png;base64,${result.predictions[0].bytesBase64Encoded}`;
      } else {
        const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: finalPrompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          })
        });
        const result = await response.json();
        const base64 = result.candidates[0].content.parts.find(p => p.inlineData)?.inlineData.data;
        if (base64) imageUrl = `data:image/png;base64,${base64}`;
      }

      if (imageUrl) {
        setSegments(prev => {
          const newSegments = [...prev];
          newSegments[index].imageUrl = imageUrl;
          newSegments[index].status = 'done';
          return newSegments;
        });
      }
    } catch (err) {
      console.error(`Index ${index} failed:`, err);
      setSegments(prev => {
        const newSegments = [...prev];
        newSegments[index].status = 'error';
        return newSegments;
      });
      throw err;
    }
  };

  const generateAllImages = async () => {
    setStatus('generating');
    setError(null);
    setLoadingProgress(0);
    
    let completedCount = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].imageUrl && segments[i].status === 'done') {
        completedCount++;
        continue;
      }

      try {
        await generateSingleImage(i);
        completedCount++;
        setLoadingProgress(Math.round((completedCount / segments.length) * 100));
      } catch (err) {
        if (err.message.includes('할당량') || err.message.includes('quota')) {
          setError(err.message);
          setStatus('prompt-generated');
          return;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    setStatus('completed');
  };

  const downloadImage = (url, index) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = `scene_${String(index + 1).padStart(2, '0')}.png`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-amber-50/20 p-4 md:p-8 font-sans text-slate-900">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white/90 backdrop-blur-xl p-8 rounded-[2.5rem] shadow-sm border border-amber-100">
          <div>
            <h1 className="text-3xl font-black text-slate-800 flex items-center gap-3">
              <Sparkles className="text-amber-500" /> AI 시네마 디렉터 master
            </h1>
            <p className="text-slate-400 text-xs font-bold uppercase tracking-[0.2em] mt-1">Real-time Scene Analysis & Progress</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <input type="password" placeholder="API Key 입력" className="px-5 py-3 bg-slate-50 rounded-2xl outline-none border border-slate-100 focus:ring-2 focus:ring-amber-400 transition-all text-sm w-full md:w-72 font-mono shadow-inner" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <button onClick={fetchModels} disabled={isFetchingModels || !apiKey} className="px-5 py-3 bg-amber-500 text-white rounded-2xl hover:bg-amber-600 disabled:bg-slate-200 transition-all shadow-lg flex items-center gap-2 text-xs font-black uppercase tracking-widest">
                {isFetchingModels ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Connect
              </button>
            </div>
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[10px] text-amber-600 hover:underline font-black mt-1 uppercase tracking-tight">API 키 발급 <ExternalLink size={10} className="inline ml-1" /></a>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Sidebar */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-white p-7 rounded-[2rem] shadow-sm border border-slate-100 space-y-6">
              <h2 className="font-black flex items-center gap-2 text-slate-700 text-sm uppercase tracking-tighter"><Settings className="w-4 h-4 text-amber-500" /> Settings</h2>
              <div className="space-y-1 text-[10px] text-amber-700 font-black bg-amber-50/50 p-5 rounded-3xl border border-amber-100/50 leading-relaxed">
                <p>• Sequential Analysis Mode (LIVE)</p>
                <p>• 2D Minimalist Character</p>
                <p>• Warm Ivory Background</p>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Analysis Engine</label>
                <select className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-xs font-bold text-slate-600 outline-none focus:border-amber-400" value={analysisModel} onChange={(e) => setAnalysisModel(e.target.value)}>
                  {availableAnalysisModels.length === 0 ? <option value="">API 연결 필요</option> : availableAnalysisModels.map(m => <option key={m.name} value={m.name.split('/').pop()}>{m.displayName}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Image Engine</label>
                <select className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-xs font-bold text-slate-600 outline-none focus:border-amber-400" value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
                  {availableImageModels.length === 0 ? <option value="">API 연결 필요</option> : availableImageModels.map(m => <option key={m.name} value={m.name.split('/').pop()}>{m.displayName}</option>)}
                </select>
              </div>
              <div className="space-y-3 pt-4 border-t border-slate-50">
                <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Scenes: <span className="text-amber-600 font-black">{imageCount}</span></label>
                <div className="grid grid-cols-4 gap-2">
                  {[10, 20, 30, 50, 100, 150, 200].map(count => (
                    <button key={count} onClick={() => setImageCount(count)} className={`py-3 text-[11px] font-black rounded-xl border transition-all ${imageCount === count ? 'bg-amber-500 text-white border-amber-500 shadow-lg' : 'bg-white text-slate-400 border-slate-100 hover:border-amber-200'}`}>{count}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="bg-white p-7 rounded-[2rem] shadow-sm border border-slate-100 space-y-4">
              <h2 className="font-black flex items-center gap-2 text-slate-700 text-sm uppercase"><ImageIcon className="w-4 h-4 text-amber-500" /> Character Reference</h2>
              <div className={`border-4 border-dashed rounded-[2rem] p-8 text-center transition-all cursor-pointer ${isDragging ? 'border-amber-500 bg-amber-50' : 'border-slate-50 hover:border-amber-200 bg-slate-50/50'}`} onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop} onClick={() => fileInputRef.current.click()}>
                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={(e) => handleFile(e.target.files[0])} />
                {referenceBase64 ? (
                  <div className="relative inline-block"><img src={`data:image/png;base64,${referenceBase64}`} className="w-32 h-32 object-cover rounded-[1.5rem] shadow-xl border-4 border-white" alt="reference" /><button className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-xs shadow-xl font-black border-2 border-white" onClick={(e) => { e.stopPropagation(); setReferenceBase64(null); }}>✕</button></div>
                ) : (
                  <div className="space-y-3 py-4"><Upload className="mx-auto w-10 h-10 text-slate-200" /><p className="text-[10px] text-slate-300 font-black uppercase">Drop Character Sheet</p></div>
                )}
              </div>
            </div>
          </div>

          {/* Main Input Area */}
          <div className="lg:col-span-3 space-y-6">
            <div className="bg-white p-8 rounded-[3rem] shadow-sm border border-slate-100 flex flex-col h-full min-h-[550px]">
              <div className="flex items-center justify-between mb-6 px-4">
                <h2 className="font-black flex items-center gap-3 text-slate-700 text-lg"><FileText className="w-5 h-5 text-amber-500" /> 유튜브 대본</h2>
                <span className="text-[10px] px-4 py-1.5 bg-slate-900 text-white rounded-full font-black shadow-md">{script.length.toLocaleString()} Chars</span>
              </div>
              <textarea className="flex-grow w-full p-10 bg-slate-50/30 border border-slate-50 rounded-[2.5rem] outline-none focus:ring-4 focus:ring-amber-50 transition-all resize-none text-lg leading-relaxed text-slate-700 shadow-inner" placeholder="대본을 입력하세요. 분석 버튼을 누르면 실시간으로 장면이 설계됩니다." value={script} onChange={(e) => setScript(e.target.value)} />
              <div className="mt-8 px-2">
                <button disabled={status === 'analyzing' || status === 'generating' || !analysisModel} onClick={generatePromptsSequentially} className="w-full py-6 bg-slate-900 text-white rounded-[2rem] font-black text-lg hover:bg-black disabled:opacity-50 transition-all shadow-2xl flex items-center justify-center gap-4 active:scale-[0.98]">
                  {status === 'analyzing' ? <Loader2 className="w-7 h-7 animate-spin" /> : <Play className="w-7 h-7 fill-white" />} 실시간 분석 및 스토리보드 설계 시작
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Global Progress & Error Message */}
        {(status === 'analyzing' || status === 'generating') && (
          <div className="bg-white/80 backdrop-blur-md p-10 rounded-[3rem] shadow-2xl border-2 border-amber-100 space-y-6 sticky top-8 z-20">
            <div className="flex justify-between items-end">
              <div>
                <span className="text-xs font-black text-amber-600 uppercase tracking-[0.3em] block mb-2">{status === 'analyzing' ? 'Analyzing Script' : 'Rendering Project'}</span>
                <span className="text-2xl font-black text-slate-800 flex items-center gap-4">
                  <Loader2 className="w-8 h-8 animate-spin text-amber-500" /> 
                  {status === 'analyzing' ? `장면 설계 중... (${segments.filter(s => s.status === 'ready' || s.status === 'done').length}/${segments.length})` : `이미지 생성 중... (${segments.filter(s => s.status === 'done').length}/${segments.length})`}
                </span>
              </div>
              <span className="text-4xl font-black text-amber-500 tabular-nums">{loadingProgress}%</span>
            </div>
            <div className="w-full bg-slate-100 h-6 rounded-full overflow-hidden border-4 border-white shadow-xl">
              <div className="bg-gradient-to-r from-amber-400 to-amber-500 h-full transition-all duration-700 ease-out" style={{ width: `${loadingProgress}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border-2 border-red-100 p-6 rounded-[2rem] flex items-start gap-5 text-red-700 text-sm shadow-xl">
            <AlertCircle className="w-8 h-8 flex-shrink-0" />
            <div className="flex-grow">
               <p className="font-black uppercase tracking-tight text-base mb-1">Attention Required</p>
               <p className="font-medium">{String(error)}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 transition-colors font-black">✕</button>
          </div>
        )}

        {/* Results Section */}
        {segments.length > 0 && (
          <div className="space-y-12 pb-40">
            <div className="flex flex-col md:flex-row items-center justify-between pt-16 border-t border-slate-200 gap-6">
              <div className="text-center md:text-left"><h2 className="text-4xl font-black text-slate-800 tracking-tighter">실시간 스토리보드</h2><p className="text-lg text-slate-400 mt-2 font-bold italic">장면이 설계되는 대로 즉시 확인하고 수정할 수 있습니다.</p></div>
              {(status === 'prompt-generated' || status === 'completed' || error) && (
                <button onClick={generateAllImages} className="px-14 py-6 bg-amber-500 text-white rounded-[2rem] font-black text-xl hover:bg-amber-600 shadow-xl transition-all flex items-center gap-4 scale-105 active:scale-95"><ImageIcon className="w-7 h-7" /> {status === 'completed' ? '전체 재생성' : '이미지 일괄 생성'}</button>
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              {segments.map((segment, idx) => (
                <div key={idx} className={`bg-white rounded-[4rem] overflow-hidden shadow-2xl border flex flex-col group transition-all duration-500 ${segment.status === 'analyzing' ? 'border-amber-200 opacity-60 scale-[0.98]' : 'border-slate-50'}`}>
                  <div className="aspect-video bg-slate-50 relative overflow-hidden">
                    {segment.imageUrl ? (
                      <img src={segment.imageUrl} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" alt="gen" />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-slate-200 bg-gradient-to-b from-slate-50 to-slate-100/50">
                        {segment.status === 'generating' || segment.status === 'analyzing' ? (
                          <div className="flex flex-col items-center gap-6">
                            <Loader2 className="w-20 h-20 animate-spin text-amber-300" />
                            <span className="text-xs font-black text-amber-400 uppercase tracking-[0.4em] animate-pulse">{segment.status === 'analyzing' ? 'Analyzing...' : 'Rendering...'}</span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-4 opacity-10">
                            <ImageIcon className="w-20 h-20" />
                            <span className="text-xs font-black uppercase tracking-[0.3em]">Scene Ready</span>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {/* Scene Controls */}
                    <div className="absolute top-8 left-8 bg-slate-900/90 text-white text-[12px] font-black px-6 py-2.5 rounded-full backdrop-blur-md shadow-2xl tracking-widest uppercase border border-white/10">SCENE {idx + 1}</div>
                    
                    <div className="absolute bottom-8 right-8 flex gap-3 opacity-0 group-hover:opacity-100 transition-all transform translate-y-10 group-hover:translate-y-0">
                       {segment.status !== 'analyzing' && (
                         <button onClick={() => generateSingleImage(idx)} className="bg-white/90 backdrop-blur-2xl p-4 rounded-3xl shadow-2xl hover:bg-amber-500 hover:text-white transition-all flex items-center gap-3 text-sm font-black text-slate-800 border border-white/20">
                           <RotateCcw className="w-5 h-5" /> {segment.imageUrl ? '재생성' : '생성'}
                         </button>
                       )}
                       {segment.imageUrl && (
                         <button onClick={() => downloadImage(segment.imageUrl, idx)} className="bg-white/90 backdrop-blur-2xl p-4 rounded-3xl shadow-2xl hover:bg-slate-800 hover:text-white transition-all flex items-center gap-3 text-sm font-black text-slate-800 border border-white/20">
                           <Download className="w-5 h-5" /> 저장
                         </button>
                       )}
                    </div>
                  </div>

                  <div className="p-12 flex flex-col gap-10">
                    <div className="bg-amber-50/50 p-8 rounded-[3rem] border border-amber-100/60 space-y-4 relative shadow-inner">
                      <Quote className="absolute -top-4 -right-4 text-amber-100/40 w-28 h-28 -rotate-12" />
                      <span className="text-[11px] font-black text-amber-600 uppercase tracking-[0.2em] flex items-center gap-2">
                        <FileText size={14} /> Script Content
                      </span>
                      <p className="text-sm text-slate-800 font-bold italic leading-relaxed">
                        {segment.start_sentence ? `"${segment.start_sentence} ... ${segment.end_sentence}"` : segment.summary}
                      </p>
                    </div>

                    {segment.status !== 'analyzing' ? (
                      <div className="grid grid-cols-1 gap-8">
                        <div className="space-y-4">
                          <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-3 px-2">
                            <ImageIcon size={16} className="text-amber-500" /> Visual Frame Design
                          </span>
                          <textarea 
                            className="w-full text-xs text-slate-600 leading-loose bg-slate-50/50 p-6 rounded-[2rem] border border-slate-100 font-bold italic resize-none shadow-inner h-32 outline-none focus:bg-white focus:border-amber-200 transition-all" 
                            value={segment.prompt || ''} 
                            onChange={(e) => { const updated = [...segments]; updated[idx].prompt = e.target.value; setSegments(updated); }} 
                          />
                        </div>
                        <div className="space-y-4">
                          <span className="text-[11px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-3 px-2">
                            <Video size={16} className="text-purple-500" /> Motion Guide
                          </span>
                          <textarea 
                            className="w-full text-xs text-purple-600/70 leading-loose bg-purple-50/20 p-6 rounded-[2rem] border border-purple-100/30 font-bold italic resize-none shadow-inner h-32 outline-none focus:bg-white focus:border-purple-200 transition-all" 
                            value={segment.video_prompt || ''} 
                            onChange={(e) => { const updated = [...segments]; updated[idx].video_prompt = e.target.value; setSegments(updated); }} 
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-6 py-10 flex flex-col items-center justify-center border-2 border-dashed border-amber-100 rounded-[3rem]">
                        <div className="w-12 h-12 rounded-full border-4 border-amber-200 border-t-amber-500 animate-spin" />
                        <span className="text-[10px] font-black text-amber-400 uppercase tracking-[0.3em]">AI Architecting...</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {status === 'completed' && (
        <div className="fixed bottom-12 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-14 py-8 rounded-full shadow-[0_40px_80px_rgba(0,0,0,0.6)] flex items-center gap-8 z-50 border border-white/10 ring-8 ring-slate-900/10 backdrop-blur-xl">
          <div className="bg-green-500 rounded-full p-4 shadow-[0_0_30px_rgba(34,197,94,0.6)] ring-4 ring-green-500/20"><CheckCircle className="text-white w-8 h-8" /></div>
          <div>
            <p className="text-xl font-black tracking-tighter">스토리보드 시각화 완성!</p>
            <p className="text-[12px] text-slate-500 font-bold tracking-widest uppercase mt-1">Ready for Video Production</p>
          </div>
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="text-[12px] font-black text-amber-400 hover:text-amber-300 uppercase tracking-widest underline underline-offset-8 decoration-2 transition-all">Back to Top</button>
        </div>
      )}
    </div>
  );
};

export default App;
