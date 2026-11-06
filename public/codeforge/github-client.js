const originalFetch = window.fetch.bind(window);

const style = document.createElement("style");
style.textContent = `
.cfgh-overlay{position:fixed;inset:0;z-index:10050;background:rgba(8,13,25,.68);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:18px}
.cfgh-panel{width:min(1120px,100%);height:min(820px,94vh);background:var(--surface,#fff);color:var(--text,#172033);border:1px solid var(--border,#e5e7eb);border-radius:20px;box-shadow:0 30px 100px #0005;display:flex;flex-direction:column;overflow:hidden}
.cfgh-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 20px;border-bottom:1px solid var(--border,#e5e7eb)}
.cfgh-head strong{font-size:16px}.cfgh-head small{display:block;color:var(--muted,#697386);margin-top:3px}
.cfgh-close,.cfgh-btn{border:1px solid var(--border,#d8deea);border-radius:10px;background:transparent;color:inherit;padding:9px 12px;cursor:pointer;font:inherit}
.cfgh-btn.primary{background:#24292f;color:#fff;border-color:#24292f}.cfgh-btn:disabled{opacity:.5;cursor:wait}
.cfgh-body{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:0;flex:1}
.cfgh-side{border-right:1px solid var(--border,#e5e7eb);overflow:auto;padding:14px}
.cfgh-main{min-width:0;overflow:auto;padding:18px}
.cfgh-section-title{font-size:11px;letter-spacing:.09em;font-weight:750;color:var(--muted,#697386);margin:4px 0 10px}
.cfgh-repo,.cfgh-file,.cfgh-pr{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:10px;padding:10px;display:block;cursor:pointer;font:inherit;margin:2px 0}
.cfgh-repo:hover,.cfgh-file:hover,.cfgh-pr:hover{background:var(--muted-bg,#f3f5f8)}.cfgh-repo.active,.cfgh-file.active{background:var(--accent-bg,#edf2ff);border-color:#9db5ff}
.cfgh-repo strong,.cfgh-pr strong{display:block;font-size:13px;overflow-wrap:anywhere}.cfgh-repo small,.cfgh-pr small{display:block;color:var(--muted,#697386);font-size:11px;margin-top:4px}
.cfgh-file{font-size:12px;overflow-wrap:anywhere;padding:7px 9px}
.cfgh-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.cfgh-input,.cfgh-textarea{width:100%;border:1px solid var(--border,#d8deea);border-radius:10px;background:var(--input,#fff);color:inherit;padding:10px;font:inherit}
.cfgh-input{min-width:0}.cfgh-textarea{min-height:300px;resize:vertical;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}
.cfgh-editor-title{font-size:15px;font-weight:700;overflow-wrap:anywhere}.cfgh-note{font-size:12px;color:var(--muted,#697386);line-height:1.5}
.cfgh-status{padding:10px 12px;border-radius:10px;background:var(--muted-bg,#f3f5f8);font-size:12px;margin:10px 0}
.cfgh-empty{padding:32px 18px;text-align:center;color:var(--muted,#697386);font-size:13px}
.cfgh-pr-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-top:12px}
.cfgh-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
@media(max-width:720px){.cfgh-overlay{padding:0}.cfgh-panel{height:100dvh;border-radius:0}.cfgh-body{grid-template-columns:1fr;grid-template-rows:minmax(150px,34%) 1fr}.cfgh-side{border-right:0;border-bottom:1px solid var(--border,#e5e7eb)}.cfgh-main{padding:13px}.cfgh-textarea{min-height:220px}}
`;
document.head.appendChild(style);

let githubStatus = null;
let repositories = [];
let selectedRepo = null;
let selectedFile = null;
let selectedFileSha = "";
let currentBranch = "";
let fileContent = "";
let treeFiles = [];
let panel = null;

async function api(path, options = {}) {
  const response = await originalFetch("/api/github/" + path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "GitHub request failed (" + response.status + ").");
  return payload;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function showToast(message) {
  const toast = document.querySelector("#toast");
  if (toast) { toast.textContent = message; toast.classList.add("show"); }
  else console.info("[Tatv AI GitHub]", message);
}
function ensurePanel() {
  if (panel?.isConnected) return;
  panel = document.createElement("div");
  panel.className = "cfgh-overlay";
  panel.innerHTML = `<section class="cfgh-panel" role="dialog" aria-modal="true" aria-label="GitHub workspace">
    <header class="cfgh-head"><div><strong>GitHub Workspace</strong><small id="cfgh-identity">Connected account</small></div><div class="cfgh-actions"><button class="cfgh-btn" id="cfgh-disconnect" type="button" hidden>Disconnect</button><button class="cfgh-close" id="cfgh-close" type="button" aria-label="Close GitHub workspace">×</button></div></header>
    <div class="cfgh-body"><aside class="cfgh-side"><div class="cfgh-section-title">YOUR REPOSITORIES</div><div id="cfgh-repos" class="cfgh-empty">Loading repositories…</div></aside>
    <main class="cfgh-main"><div id="cfgh-main-content" class="cfgh-empty">Choose a repository to browse its files, import source into chat, edit a file, or manage pull requests.</div></main></div>
  </section>`;
  document.body.appendChild(panel);
  panel.querySelector("#cfgh-close").addEventListener("click", closePanel);
  panel.querySelector("#cfgh-disconnect").addEventListener("click", () => { void disconnectGitHub(); });
  panel.addEventListener("click", event => { if (event.target === panel) closePanel(); });
  document.addEventListener("keydown", escapePanel);
}
function closePanel() {
  panel?.remove(); panel = null;
  document.removeEventListener("keydown", escapePanel);
}
function escapePanel(event) { if (event.key === "Escape") closePanel(); }
function mainNode() { return panel?.querySelector("#cfgh-main-content"); }
function sideNode() { return panel?.querySelector("#cfgh-repos"); }
async function refreshStatus() {
  githubStatus = await api("status");
  return githubStatus;
}
async function connectGitHub() {
  try {
    const status = await refreshStatus();
    if (status.requiresSignIn) {
      showToast("Sign in to Tatv AI from the profile menu before connecting GitHub.");
      return;
    }
    if (!status.configured) {
      openSetup(status);
      return;
    }
    window.location.assign("/api/github/connect");
  } catch (error) { showToast(error.message); }
}
function openSetup(status) {
  ensurePanel();
  const main = mainNode();
  const missing = Array.isArray(status.missing) ? status.missing : [];
  main.className = "";
  main.innerHTML = `<h2>Finish GitHub setup</h2><p class="cfgh-note">The GitHub OAuth backend is in place. Add the missing server-side settings in Vercel before connecting.</p><div class="cfgh-status">Missing settings: ${esc(missing.join(", ") || "OAuth configuration")}</div><p class="cfgh-note">GitHub OAuth callback URL (set this exact URL in your GitHub OAuth App):<br><strong>${esc(location.origin + "/api/github/callback")}</strong></p><p class="cfgh-note">Never paste the Client Secret into the browser or a chat message. Add it directly to Vercel as GITHUB_CLIENT_SECRET. The token-encryption key is server-only.</p>`;
}
async function openWorkspace() {
  ensurePanel();
  try {
    await refreshStatus();
    if (!githubStatus?.connected) {
      closePanel();
      showToast("GitHub is not connected to this Tatv AI account. Connect it again from Integrations.");
      return;
    }
    const identity = panel.querySelector("#cfgh-identity");
    identity.textContent = githubStatus.login ? "Connected as @" + githubStatus.login : "Connected GitHub account";
    panel.querySelector("#cfgh-disconnect").hidden = false;
    await loadRepositories();
  } catch (error) {
    showToast(error.message || "GitHub Workspace could not be opened.");
  }
}
async function disconnectGitHub() {
  if (!confirm("Disconnect GitHub from this Tatv AI account? Repository access will stop until you connect again.")) return;
  try {
    const result = await api("disconnect", { method: "POST", body: JSON.stringify({}) });
    closePanel();
    showToast(result.revoked
      ? "GitHub disconnected and its OAuth grant was revoked."
      : "GitHub disconnected locally. If the authorization remains in GitHub, remove Tatv AI from Settings → Applications.");
    window.location.reload();
  } catch (error) { showToast(error.message || "GitHub could not be disconnected."); }
}
async function loadRepositories() {
  const node = sideNode();
  node.className = "cfgh-empty";
  node.textContent = "Loading repositories…";
  try {
    const payload = await api("repos");
    repositories = payload.repositories || [];
    if (!repositories.length) { node.textContent = "No repositories were returned for this account."; return; }
    node.className = "";
    node.innerHTML = repositories.map(repo => `<button class="cfgh-repo" type="button" data-repo="${esc(repo.fullName)}"><strong>${esc(repo.fullName)}</strong><small>${repo.private ? "Private" : "Public"} · ${esc(repo.defaultBranch || "main")}</small></button>`).join("");
    node.querySelectorAll("[data-repo]").forEach(button => button.addEventListener("click", () => selectRepository(button.dataset.repo)));
  } catch (error) { node.textContent = error.message; }
}
async function selectRepository(fullName) {
  selectedRepo = repositories.find(repo => repo.fullName === fullName);
  if (!selectedRepo) return;
  currentBranch = selectedRepo.defaultBranch || "main";
  selectedFile = null;
  panel.querySelectorAll("[data-repo]").forEach(button => button.classList.toggle("active", button.dataset.repo === fullName));
  const main = mainNode();
  main.className = "";
  main.innerHTML = `<h2>${esc(fullName)}</h2><p class="cfgh-note">${esc(selectedRepo.description || "Repository source and pull request workspace")}</p><div class="cfgh-toolbar"><span class="cfgh-note">Branch</span><input class="cfgh-input" id="cfgh-branch" value="${esc(currentBranch)}" aria-label="Branch name"><button class="cfgh-btn" id="cfgh-load-tree" type="button">Load files</button></div><div class="cfgh-section-title">SOURCE FILES</div><div id="cfgh-files" class="cfgh-empty">Loading file tree…</div><div id="cfgh-editor-area"></div><div class="cfgh-section-title" style="margin-top:22px">PULL REQUESTS</div><div id="cfgh-pulls" class="cfgh-empty">Loading pull requests…</div>`;
  main.querySelector("#cfgh-load-tree").addEventListener("click", () => loadTree());
  main.querySelector("#cfgh-branch").addEventListener("change", event => { currentBranch = event.target.value.trim() || selectedRepo.defaultBranch; });
  await Promise.all([loadTree(), loadPulls()]);
}
async function loadTree() {
  if (!selectedRepo) return;
  const node = mainNode()?.querySelector("#cfgh-files");
  if (!node) return;
  node.className = "cfgh-empty"; node.textContent = "Loading repository files…";
  try {
    const payload = await api("tree?repo=" + encodeURIComponent(selectedRepo.fullName) + "&branch=" + encodeURIComponent(currentBranch));
    treeFiles = payload.files || [];
    node.className = "";
    node.innerHTML = treeFiles.length
      ? treeFiles.map(file => `<button class="cfgh-file" type="button" data-file="${esc(file.path)}">▤ &nbsp;${esc(file.path)} <small> · ${Number(file.size || 0).toLocaleString()} bytes</small></button>`).join("")
      : '<div class="cfgh-empty">No files found on this branch.</div>';
    node.querySelectorAll("[data-file]").forEach(button => button.addEventListener("click", () => openFile(button.dataset.file)));
    if (payload.truncated) node.insertAdjacentHTML("beforeend", '<p class="cfgh-note">GitHub truncated this tree response; showing the first 500 source entries.</p>');
  } catch (error) { node.textContent = error.message; }
}
async function openFile(path) {
  const area = mainNode()?.querySelector("#cfgh-editor-area");
  if (!area || !selectedRepo) return;
  area.innerHTML = '<div class="cfgh-status">Importing ' + esc(path) + '…</div>';
  try {
    const payload = await api("file?repo=" + encodeURIComponent(selectedRepo.fullName) + "&path=" + encodeURIComponent(path) + "&ref=" + encodeURIComponent(currentBranch));
    selectedFile = path;
    selectedFileSha = payload.file.sha || "";
    fileContent = payload.file.content || "";
    area.innerHTML = `<div class="cfgh-toolbar"><strong class="cfgh-editor-title">${esc(path)}</strong><span class="cfgh-note">Loaded from ${esc(currentBranch)}</span></div><textarea class="cfgh-textarea" id="cfgh-editor" spellcheck="false" aria-label="Edit repository file"></textarea><div class="cfgh-actions"><button class="cfgh-btn" id="cfgh-import" type="button">Import into AI chat</button><button class="cfgh-btn primary" id="cfgh-save" type="button">Commit file</button></div><p class="cfgh-note">Changes are written to the selected branch. For safer work, create a feature branch first, then open a pull request.</p><div class="cfgh-toolbar"><input class="cfgh-input" id="cfgh-commit-message" value="Update ${esc(path.split("/").pop())}" aria-label="Commit message"></div><div class="cfgh-actions"><input class="cfgh-input" id="cfgh-new-branch" value="ai/codeforge-${Date.now().toString(36)}" aria-label="New branch name"><button class="cfgh-btn" id="cfgh-create-branch" type="button">Create feature branch</button></div><div class="cfgh-note" id="cfgh-editor-status" role="status"></div>`;
    const editor = area.querySelector("#cfgh-editor");
    editor.value = fileContent;
    area.querySelector("#cfgh-import").addEventListener("click", () => importIntoChat(path, editor.value));
    area.querySelector("#cfgh-create-branch").addEventListener("click", () => createFeatureBranch());
    area.querySelector("#cfgh-save").addEventListener("click", () => commitFile());
  } catch (error) { area.textContent = error.message; }
}
function importIntoChat(path, content) {
  const prompt = document.querySelector("#promptInput");
  if (!prompt) { showToast("Chat composer is not available."); return; }
  const excerpt = content.length > 24_000 ? content.slice(0, 24_000) + "\n\n[File truncated for chat context.]" : content;
  prompt.value = (prompt.value ? prompt.value + "\n\n" : "") + "Please inspect this imported GitHub source file from " + selectedRepo.fullName + " (" + currentBranch + "): " + path + "\n\n\x60\x60\x60\n" + excerpt + "\n\x60\x60\x60\n\nExplain the issues and propose a safe, complete fix. Do not assume access to other repository files.";
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  closePanel();
  showToast("GitHub file imported into the AI chat.");
}
async function createFeatureBranch() {
  const name = mainNode()?.querySelector("#cfgh-new-branch")?.value.trim();
  const status = mainNode()?.querySelector("#cfgh-editor-status");
  if (!name || !selectedRepo) return;
  try {
    const payload = await api("branch", { method: "POST", body: JSON.stringify({ repo: selectedRepo.fullName, name, base: currentBranch }) });
    currentBranch = payload.branch.name;
    const branchInput = mainNode().querySelector("#cfgh-branch");
    if (branchInput) branchInput.value = currentBranch;
    if (status) status.textContent = "Created branch " + currentBranch + ". Reload the file tree before editing additional files.";
    showToast("Feature branch created.");
  } catch (error) { if (status) status.textContent = error.message; }
}
async function commitFile() {
  const editor = mainNode()?.querySelector("#cfgh-editor");
  const message = mainNode()?.querySelector("#cfgh-commit-message")?.value.trim();
  const status = mainNode()?.querySelector("#cfgh-editor-status");
  if (!editor || !message || !selectedRepo || !selectedFile) return;
  if (currentBranch === (selectedRepo.defaultBranch || "main")) {
    if (status) status.textContent = "Create a feature branch before committing. The default branch is protected in this workspace.";
    showToast("Create a feature branch before saving code.");
    return;
  }
  const button = mainNode().querySelector("#cfgh-save");
  button.disabled = true;
  if (status) status.textContent = "Committing file to " + currentBranch + "…";
  try {
    const payload = await api("commit", { method: "POST", body: JSON.stringify({ repo: selectedRepo.fullName, branch: currentBranch, path: selectedFile, content: editor.value, message, expectedSha: selectedFileSha }) });
    selectedFileSha = payload.content?.sha || selectedFileSha;
    fileContent = editor.value;
    if (status) status.textContent = "Commit saved to " + currentBranch + ".";
    showToast("File committed to GitHub.");
    await loadTree();
  } catch (error) { if (status) status.textContent = error.message; }
  finally { if (button?.isConnected) button.disabled = false; }
}
async function loadPulls() {
  const node = mainNode()?.querySelector("#cfgh-pulls");
  if (!node || !selectedRepo) return;
  node.className = "cfgh-empty"; node.textContent = "Loading pull requests…";
  try {
    const payload = await api("pulls?repo=" + encodeURIComponent(selectedRepo.fullName));
    const pulls = payload.pullRequests || [];
    node.className = "";
    node.innerHTML = pulls.length ? '<div class="cfgh-pr-grid">' + pulls.map(pr => `<article class="cfgh-pr"><strong>#${pr.number} · ${esc(pr.title)}</strong><small>${esc(pr.head)} → ${esc(pr.base)} · @${esc(pr.user)}</small><div class="cfgh-actions"><button class="cfgh-btn" data-pr-comment="${pr.number}" type="button">Comment</button><button class="cfgh-btn primary" data-pr-merge="${pr.number}" data-head-sha="${esc(pr.headSha)}" type="button">Merge</button><a class="cfgh-btn" href="${esc(pr.htmlUrl)}" target="_blank" rel="noopener noreferrer">Open PR ↗</a></div></article>`).join("") + '</div>' : '<div class="cfgh-empty">No open pull requests.</div>';
    node.querySelectorAll("[data-pr-comment]").forEach(button => button.addEventListener("click", () => commentOnPull(Number(button.dataset.prComment))));
    node.querySelectorAll("[data-pr-merge]").forEach(button => button.addEventListener("click", () => mergePull(Number(button.dataset.prMerge), button.dataset.headSha)));
    const create = document.createElement("div");
    create.className = "cfgh-actions";
    create.innerHTML = '<button type="button" class="cfgh-btn primary" id="cfgh-create-pr">Create pull request from current branch</button>';
    node.appendChild(create);
    create.querySelector("#cfgh-create-pr").addEventListener("click", createPullRequest);
  } catch (error) { node.textContent = error.message; }
}
async function createPullRequest() {
  if (!selectedRepo) return;
  if (currentBranch === (selectedRepo.defaultBranch || "main")) {
    showToast("Create a feature branch before opening a pull request.");
    return;
  }
  const title = prompt("Pull request title", "Tatv AI improvements");
  if (!title) return;
  const description = prompt("Describe the changes", "Changes prepared in Tatv AI GitHub Workspace.");
  if (description === null) return;
  try {
    const payload = await api("pulls", { method: "POST", body: JSON.stringify({ repo: selectedRepo.fullName, title, body: description, head: currentBranch, base: selectedRepo.defaultBranch || "main" }) });
    showToast("Pull request #" + payload.pullRequest.number + " created.");
    await loadPulls();
  } catch (error) { showToast(error.message); }
}
async function commentOnPull(number) {
  const comment = prompt("Write a comment for pull request #" + number);
  if (!comment?.trim()) return;
  try {
    await api("comment", { method: "POST", body: JSON.stringify({ repo: selectedRepo.fullName, number, comment }) });
    showToast("Pull request comment posted.");
  } catch (error) { showToast(error.message); }
}
async function mergePull(number, headSha) {
  if (!confirm("Merge pull request #" + number + " into " + selectedRepo.defaultBranch + "? This changes the repository immediately.")) return;
  try {
    const payload = await api("merge", { method: "POST", body: JSON.stringify({ repo: selectedRepo.fullName, number, method: "squash", expectedHeadSha: headSha }) });
    showToast(payload.message || "Pull request merged.");
    await loadPulls();
  } catch (error) { showToast(error.message); }
}
async function openGitHub() {
  try {
    const status = await refreshStatus();
    if (status.connected) await openWorkspace();
    else if (status.configured) await connectGitHub();
    else openSetup(status);
  } catch (error) { showToast(error.message); }
}
document.addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target : null;
  const trigger = target?.closest('[data-connect="github"]');
  if (!trigger) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void openGitHub();
}, true);

function attachApplyToEditorButtons(root) {
  root.querySelectorAll(".assistant-code-block").forEach(block => {
    if (block.querySelector("[data-cfgh-use-code]")) return;
    const code = block.querySelector("pre code");
    if (!code) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assistant-code-copy";
    button.dataset.cfghUseCode = "true";
    button.textContent = "Open in GitHub editor";
    button.title = "Review this generated code in the selected GitHub file editor";
    block.querySelector(".assistant-code-header")?.appendChild(button);
    button.addEventListener("click", async () => {
      if (!selectedRepo || !selectedFile) {
        showToast("First connect GitHub and import a file into this chat.");
        void openGitHub();
        return;
      }
      try {
        if (!panel?.isConnected) await openWorkspace();
        await selectRepository(selectedRepo.fullName);
        await openFile(selectedFile);
        const editor = mainNode()?.querySelector("#cfgh-editor");
        if (editor) {
          editor.value = code.textContent || "";
          const editorStatus = mainNode()?.querySelector("#cfgh-editor-status");
          if (editorStatus) editorStatus.textContent = "AI-generated code loaded for review. Check the complete file before committing.";
          showToast("AI code loaded into the GitHub editor. Review it before committing.");
        }
      } catch (error) { showToast(error.message || "Could not open the GitHub editor."); }
    });
  });
}
const messageRoot = document.querySelector("#messages");
if (messageRoot) {
  const codeObserver = new MutationObserver(() => attachApplyToEditorButtons(messageRoot));
  codeObserver.observe(messageRoot, { childList: true, subtree: true });
  attachApplyToEditorButtons(messageRoot);
}

const githubReturn = new URLSearchParams(location.search);
if (githubReturn.has("github")) {
  const result = githubReturn.get("github");
  history.replaceState(null, "", location.pathname + location.hash);
  if (result === "connected") {
    void openWorkspace();
    showToast("GitHub connected successfully.");
  } else showToast("GitHub connection was not completed. Check the OAuth settings and try again.");
}
