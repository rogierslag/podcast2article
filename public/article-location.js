export function articleHash(jobId, sectionId) {
  const parameters = new URLSearchParams({ job: jobId });
  if (sectionId) {
    parameters.set("section", sectionId);
  }
  return `#${parameters}`;
}

export function readArticleLocation(hash) {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  const jobId = parameters.get("job");
  const timeValue = parameters.get("time");
  const time = timeValue === null ? undefined : Number(timeValue);
  return {
    jobId: /^[0-9a-f-]{36}$/i.test(jobId || "") ? jobId : undefined,
    sectionId: parameters.get("section") || undefined,
    time: Number.isFinite(time) && time >= 0 ? time : undefined,
  };
}
