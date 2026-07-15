const $ = (selector) => document.querySelector(selector);
const landing = $("#landing");
const progressView = $("#progress-view");
const resultView = $("#result-view");
const form = $("#job-form");
let currentJob;

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const time = (seconds) => { const value=Math.max(0,Math.floor(seconds)); const h=Math.floor(value/3600); const m=Math.floor(value%3600/60); const s=value%60; return h?`${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`:`${m}:${String(s).padStart(2,"0")}`; };

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  const data = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch("/api/jobs", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "De opdracht kon niet starten.");
    location.hash = `job=${body.id}`;
    showProgress(body);
    poll(body.id);
  } catch (error) { $("#form-error").textContent = error.message; }
});

function showProgress(job) {
  landing.classList.add("hidden"); resultView.classList.add("hidden"); progressView.classList.remove("hidden");
  $("#progress-message").textContent = job.message;
  $("#progress-bar").style.width = `${job.progress}%`;
  $("#progress-percent").textContent = `${job.progress}%`;
  if (job.episode) $("#progress-title").textContent = job.episode.title;
}

async function poll(id) {
  try {
    const response = await fetch(`/api/jobs/${id}`);
    if (!response.ok) throw new Error("Opdracht niet gevonden.");
    const job = await response.json();
    showProgress(job);
    if (job.stage === "complete") return renderResult(job);
    if (job.stage === "failed") throw new Error(job.error || "Verwerking mislukt.");
    setTimeout(() => poll(id), 1800);
  } catch (error) {
    progressView.classList.add("hidden"); landing.classList.remove("hidden");
    $("#form-error").textContent = error.message;
  }
}

function sourceButtons(ids, transcript) {
  return `<span class="sources">${ids.map((id) => { const item=transcript.find((part)=>part.id===id); return item?`<button class="source-link" data-source="${id}" title="Ga naar transcript op ${time(item.start)}">${time(item.start)}</button>`:""; }).join("")}</span>`;
}

function slug(value, index) { return `section-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}`; }

function renderResult(job) {
  currentJob = job;
  progressView.classList.add("hidden"); landing.classList.add("hidden"); resultView.classList.remove("hidden");
  const episode=job.episode, article=job.article, transcript=job.transcript;
  $("#episode-hero").innerHTML = `${episode.imageUrl?`<img src="${escapeHtml(episode.imageUrl)}" alt="Cover van ${escapeHtml(episode.podcast)}">`:""}<div><span class="kicker">${escapeHtml(episode.podcast)}</span><h1>${escapeHtml(episode.title)}</h1><p>${episode.publishedAt?new Date(episode.publishedAt).toLocaleDateString("nl-NL",{dateStyle:"long"}):""}${episode.durationSeconds?` · ${Math.round(episode.durationSeconds/60)} minuten`:""} · <a href="${escapeHtml(episode.spotifyUrl)}" target="_blank" rel="noreferrer" style="color:inherit">Bekijk op Spotify ↗</a></p></div>`;
  const sections=article.sections.map((section,index)=>{const id=slug(section.heading,index);return `<section><h2 id="${id}">${escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph)=>`<p>${escapeHtml(paragraph.text)} ${sourceButtons(paragraph.sources,transcript)}</p>`).join("")}</section>`}).join("");
  $("#article").innerHTML = `<h1>${escapeHtml(article.title)}</h1><p class="dek">${escapeHtml(article.dek)}</p><p class="byline">${article.readingTimeMinutes} minuten leestijd · gebaseerd op ${transcript.length} bronfragmenten</p><p class="style-note">${escapeHtml(article.styleNote)}</p>${sections}<div class="takeaways"><h2>Kernpunten</h2><ul>${article.takeaways.map((item)=>`<li>${escapeHtml(item.text)} ${sourceButtons(item.sources,transcript)}</li>`).join("")}</ul></div>`;
  $("#toc").innerHTML = article.sections.map((section,index)=>`<a href="#${slug(section.heading,index)}">${escapeHtml(section.heading)}</a>`).join("");
  $("#audio").src = episode.audioUrl;
  renderTranscript(transcript, "");
  document.addEventListener("click", sourceClick);
  window.scrollTo({top:0});
}

function renderTranscript(transcript, query) {
  const normalized=query.trim().toLowerCase();
  $("#transcript").innerHTML=transcript.map((part)=>{
    const match=!normalized||part.text.toLowerCase().includes(normalized)||part.speaker.toLowerCase().includes(normalized);
    let textValue=escapeHtml(part.text);
    if(normalized&&match){const escaped=normalized.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");textValue=textValue.replace(new RegExp(`(${escaped})`,"ig"),"<mark>$1</mark>");}
    return `<div class="segment" id="${part.id}" ${match?"":"hidden"}><button class="timestamp" data-time="${part.start}">${time(part.start)}</button><span class="speaker">${escapeHtml(part.speaker)}</span><p>${textValue}</p></div>`;
  }).join("");
}

function sourceClick(event) {
  const source=event.target.closest("[data-source]");
  const timestamp=event.target.closest("[data-time]");
  if(source){const segment=document.getElementById(source.dataset.source); if(segment){segment.hidden=false; segment.scrollIntoView({behavior:"smooth",block:"center"}); segment.classList.remove("flash"); void segment.offsetWidth; segment.classList.add("flash"); const part=currentJob.transcript.find((item)=>item.id===source.dataset.source); if(part) seek(part.start);}}
  if(timestamp) seek(Number(timestamp.dataset.time));
}
function seek(seconds){const audio=$("#audio");audio.currentTime=seconds;audio.play().catch(()=>undefined);}
$("#transcript").addEventListener("click", sourceClick);
$("#transcript-search").addEventListener("input",(event)=>currentJob&&renderTranscript(currentJob.transcript,event.target.value));
$("#toggle-transcript").addEventListener("click",()=>{const transcript=$("#transcript");transcript.classList.toggle("hidden");$("#toggle-transcript").textContent=transcript.classList.contains("hidden")?"Toon":"Verberg";});

const hashMatch=location.hash.match(/^#job=([0-9a-f-]{36})$/i); if(hashMatch) poll(hashMatch[1]);
