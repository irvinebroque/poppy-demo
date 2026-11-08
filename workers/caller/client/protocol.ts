export type PiToolInfo = {
  readonly name: string;
  readonly description: string;
};

export type { PiToolInfo as ToolInfo };

export type { PiMessage as TranscriptMessage, PiMessagePart as TranscriptPart } from "./transcript";

export type { PiSessionView as SessionView } from "./view";
