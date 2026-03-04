export interface PythonReferenceQuery {
  symbol: string;
  filePath?: string;
  includeDeclaration?: boolean;
  limit: number;
}

export interface PythonReferenceResult {
  backend: "python-static" | "python-jedi" | "none";
  confidence: "high" | "medium" | "low";
  references: string[];
  reason?: string;
  candidates?: string[];
}

export interface PythonSemanticProvider {
  readonly name: string;
  warmup(): Promise<void>;
  findReferences(query: PythonReferenceQuery): Promise<PythonReferenceResult>;
}
