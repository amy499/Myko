const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopCat", {
  dragWindow: (delta) => ipcRenderer.send("drag-window", delta),

  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  describeScreen: (imageBuffer) =>
    ipcRenderer.invoke("describe-screen", imageBuffer),
  getCatResponse: (description, memory) =>
    ipcRenderer.invoke("get-cat-response", description, memory),
  readMemory: () => ipcRenderer.invoke("read-memory"),
  writeMemory: (memory) => ipcRenderer.invoke("write-memory", memory),

  getContext: () => ipcRenderer.invoke("cat:getContext"),
  capturePrimary: () => ipcRenderer.invoke("cat:capturePrimary"),
  summarizePdf: (b64) => ipcRenderer.invoke("cat:summarizePdf", b64),
  analyzeEmail: (mail) => ipcRenderer.invoke("cat:analyzeEmail", mail),

  speak: (payload) => ipcRenderer.invoke("cat:speak", payload),
  hasVoiceKey: () => ipcRenderer.invoke("cat:hasVoiceKey"),
  hasTranscriptionKey: () => ipcRenderer.invoke("cat:hasTranscriptionKey"),
  replyToUser: (text) => ipcRenderer.invoke("cat:replyToUser", text),
  transcribe: (audio, mimeType) =>
    ipcRenderer.invoke("cat:transcribe", audio, mimeType),
  proactiveAssist: () => ipcRenderer.invoke("cat:proactiveAssist"),

  getSettings: () => ipcRenderer.invoke("cat:getSettings"),
  setSettings: (partial) => ipcRenderer.invoke("cat:setSettings", partial),

  onMouseQuestion: (cb) =>
    ipcRenderer.on("cat:mouseQuestion", (_e, q) => cb(q)),

  // Voice listener pipeline (listener.js / Task 4)
  listenerStart: () => ipcRenderer.send("listener:start"),
  listenerStop: (base64) => ipcRenderer.invoke("listener:stop", base64),
  onListenerResult: (cb) =>
    ipcRenderer.on("listener:result", (_e, data) => cb(data)),
  onListenerError: (cb) =>
    ipcRenderer.on("listener:error", (_e, data) => cb(data)),
});
