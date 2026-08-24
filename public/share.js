const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);
const time = (seconds) => { const value=Math.max(0,Math.floor(seconds));const hours=Math.floor(value/3600);const minutes=Math.floor(value%3600/60);const remainder=value%60;return hours?`${hours}:${String(minutes).padStart(2,"0")}:${String(remainder).padStart(2,"0")}`:`${minutes}:${String(remainder).padStart(2,"0")}`; };
const slug = (value,index) => `section-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}`;

function sourceButtons(ids,sources) {
  return `<span class="sources">${ids.map((id)=>{const source=sources.find((item)=>item.id===id);return source?`<button class="source-link" data-time="${source.start}" title="Luister vanaf ${time(source.start)}">${time(source.start)}</button>`:"";}).join("")}</span>`;
}

function renderSharedArticle(shared,token) {
  const {episode,article,sources}=shared;
  const details=[episode.publishedAt?new Date(episode.publishedAt).toLocaleDateString("nl-NL",{dateStyle:"long"}):"",episode.durationSeconds?`${Math.round(episode.durationSeconds/60)} minuten`:""].filter(Boolean);
  const sourceLabel=episode.sourceType==="google-drive"?"Bekijk in Google Drive ↗":episode.sourceType==="youtube"?"Bekijk op YouTube ↗":"Bekijk op Spotify ↗";
  $("#episode-hero").innerHTML=`${episode.imageUrl?`<img src="${escapeHtml(episode.imageUrl)}" alt="Afbeelding van ${escapeHtml(episode.sourceName)}">`:""}<div><span class="kicker">${escapeHtml(episode.sourceName)}</span><h1>${escapeHtml(episode.title)}</h1><p>${escapeHtml(details.join(" · "))}${details.length?" · ":""}<a href="${escapeHtml(episode.sourceUrl)}" target="_blank" rel="noreferrer" style="color:inherit">${sourceLabel}</a></p></div>`;
  const sections=article.sections.map((section,index)=>`<section><h2 id="${slug(section.heading,index)}">${escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph)=>`<p>${escapeHtml(paragraph.text)} ${sourceButtons(paragraph.sources,sources)}</p>`).join("")}</section>`).join("");
  $("#article").innerHTML=`<h1>${escapeHtml(article.title)}</h1><p class="dek">${escapeHtml(article.dek)}</p><p class="byline">${article.readingTimeMinutes} minuten leestijd · anoniem gedeeld</p><p class="style-note">${escapeHtml(article.styleNote)}</p>${sections}<div class="takeaways"><h2>Kernpunten</h2><ul>${article.takeaways.map((item)=>`<li>${escapeHtml(item.text)} ${sourceButtons(item.sources,sources)}</li>`).join("")}</ul></div>`;
  $("#toc").innerHTML=article.sections.map((section,index)=>`<a href="#${slug(section.heading,index)}">${escapeHtml(section.heading)}</a>`).join("");
  $("#audio").src=`/api/shared/${encodeURIComponent(token)}/audio`;
  $("#shared-loading").classList.add("hidden");
  $("#shared-result").classList.remove("hidden");
}

$("#shared-main").addEventListener("click",(event)=>{
  const button=event.target.closest("[data-time]");
  if(!button)return;
  const audio=$("#audio");
  audio.currentTime=Number(button.dataset.time);
  audio.play().catch(()=>undefined);
  audio.scrollIntoView({behavior:"smooth",block:"center"});
});

const token=location.pathname.split("/").filter(Boolean).at(-1);
fetch(`/api/shared/${encodeURIComponent(token)}`).then(async(response)=>{
  if(!response.ok)throw new Error("not found");
  renderSharedArticle(await response.json(),token);
}).catch(()=>{
  $("#shared-loading").classList.add("hidden");
  $("#shared-error").classList.remove("hidden");
});
