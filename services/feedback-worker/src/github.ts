export interface CreatedIssue {
  html_url: string;
  number: number;
}

export async function createIssue(
  token: string,
  repo: string,
  payload: { title: string; body: string; labels: string[] },
): Promise<CreatedIssue> {
  const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bubble-feedback-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return (await resp.json()) as CreatedIssue;
}
