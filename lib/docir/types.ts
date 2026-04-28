export type DocBlockType =
  | "heading"
  | "paragraph"
  | "listItem"
  | "tableCell"
  | "blockquote"
  | "callout"
  | "description"
  | "caption";

export type ProtectedToken = {
  placeholder: string;
  value: string;
};

export type DocTextPatch = {
  node: { value: string };
  source: string;
  protectedSource: string;
  prefix: string;
  suffix: string;
  tokens: ProtectedToken[];
};

export type DocBlock = {
  id: string;
  type: DocBlockType;
  text: string;
  patchCount: number;
};

export type ExtractedDocPage = {
  title: string | null;
  rootFound: boolean;
  blocks: DocBlock[];
  patches: DocTextPatch[];
};
