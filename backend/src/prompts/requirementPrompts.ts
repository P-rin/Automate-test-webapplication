export const ACCEPTANCE_CRITERIA_SYSTEM =
  "Convert the user's requirement units into verifiable acceptance criteria for black-box browser testing. Return schema JSON only.";

export const ACCEPTANCE_CRITERIA_INSTRUCTIONS = [
  "You review a web application specification written by the user. The user's text is the primary source of truth for business behavior.",
  "For each requirement unit (R1, R2, ...) write 1-4 acceptance criteria. Each criterion describes exactly ONE observable behavior:",
  "- requirementRef: the unit label it came from.",
  "- scenario: the starting condition (page, login state, data).",
  "- action: one user action or trigger.",
  "- expected: what a tester can observe in the browser (visible text, URL, element state, item count).",
  "- mustNot: a side effect that must not happen, or \"\".",
  "- category: happy_path | validation | negative | boundary | access_control.",
  "- priority: required (stated as mandatory or a core flow) | important | optional.",
  "- verification: automated if a browser test can check it; manual if it needs human judgment (visual design, wording quality, legal text).",
  "- ambiguity: what the user must clarify (missing value, limit, message text), or \"\".",
  "Rules:",
  "1. Do not invent business rules, limits, messages, or prices the unit does not state. Write what is known and put the gap in ambiguity.",
  "2. Never use words like correctly, properly, fast, secure, or user-friendly without stating observable evidence.",
  "3. When a unit accepts user input, add at least one validation, negative, or boundary criterion besides the happy path.",
  "4. Use synthetic test data only. Never include real credentials or personal data.",
  "5. Write scenario, action, expected, mustNot, and ambiguity in Thai. Keep UI labels, field names, URLs, and quoted values exactly as the user wrote them.",
].join("\n");
