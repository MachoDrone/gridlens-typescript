export type InfoTone = "positive" | "negative" | "warning" | "muted" | "accent" | "plain";

export interface InfoPart {
  readonly text: string;
  readonly tone?: InfoTone;
}

export type InfoText = string | readonly InfoPart[];

/** Authored explanations; original provenance stays behind a closed disclosure. */
export interface InfoContent {
  readonly summary: InfoText;
  readonly facts?: readonly InfoText[];
  readonly source?: string;
}

/** Plain equivalent for accessible descriptions and short hover text. */
export function infoText(value: InfoText): string {
  return typeof value === "string" ? value : value.map(part => part.text).join("");
}

function renderText(target: HTMLElement, value: InfoText): void {
  if (typeof value === "string") {
    target.textContent = value;
    return;
  }
  for (const part of value) {
    const span = target.ownerDocument.createElement("span");
    span.className = `info-tone-${part.tone ?? "plain"}`;
    span.textContent = part.text;
    target.append(span);
  }
}

/** Render text only: source values are never parsed as markup or rewritten. */
export function renderInfoContent(target: HTMLElement, content: InfoContent): void {
  const document = target.ownerDocument;
  const fragment = document.createDocumentFragment();
  const summary = document.createElement("p");
  summary.className = "info-summary";
  renderText(summary, content.summary);
  fragment.append(summary);

  if (content.facts && content.facts.length > 0) {
    const facts = document.createElement("ul");
    facts.className = "info-facts";
    for (const fact of content.facts.slice(0, 4)) {
      const item = document.createElement("li");
      renderText(item, fact);
      facts.append(item);
    }
    fragment.append(facts);
  }

  if (content.source !== undefined) {
    const details = document.createElement("details");
    details.className = "info-source";
    const label = document.createElement("summary");
    label.textContent = "Source details";
    const body = document.createElement("div");
    body.className = "info-source-body";
    body.textContent = content.source;
    details.append(label, body);
    fragment.append(details);
  }

  target.replaceChildren(fragment);
}
