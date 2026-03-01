import { createHash } from "node:crypto";
import * as ts from "typescript";
import type { Chunk, Chunker, SymbolKind } from "../types.js";
import { TreeSitterLoader, type TreeSitterLanguage } from "./tree-sitter-loader.js";

export interface AstChunkerOptions {
  /**
   * Prefer tree-sitter parser output when available.
   * If false, always uses built-in baseline parsers.
   */
  preferTreeSitter?: boolean;
  treeSitterLoader?: TreeSitterLoader;
}

/**
 * AST-aware chunker.
 *
 * Order of operations:
 * 1) If enabled and ready, use tree-sitter parser for language
 * 2) Otherwise fallback to baseline parsers:
 *    - TS/JS via TypeScript compiler AST
 *    - Python via indentation-aware scanner
 */
export class AstChunker implements Chunker {
  private readonly preferTreeSitter: boolean;
  private readonly treeSitter: TreeSitterLoader;

  constructor(options: AstChunkerOptions = {}) {
    this.preferTreeSitter = options.preferTreeSitter ?? true;
    this.treeSitter = options.treeSitterLoader ?? new TreeSitterLoader();
  }

  async warmupTreeSitter(languages: TreeSitterLanguage[] = ["typescript", "javascript", "python"]): Promise<void> {
    await this.treeSitter.warmup(languages);
  }

  getTreeSitterWarnings(): string[] {
    return this.treeSitter.getWarnings();
  }

  chunk(content: string, filePath: string, language: string, repoId: string): Chunk[] {
    if (!content.trim()) return [];

    if (this.preferTreeSitter && isTreeSitterLanguage(language) && this.treeSitter.isReady(language)) {
      const treeSitterChunks = this.chunkWithTreeSitter(content, filePath, language, repoId);
      if (treeSitterChunks.length > 0) {
        return dedupeChunks(treeSitterChunks);
      }
    }

    if (language === "typescript" || language === "javascript") {
      return this.chunkTsJs(content, filePath, language, repoId);
    }

    if (language === "python") {
      return this.chunkPython(content, filePath, repoId);
    }

    return [];
  }

  private chunkWithTreeSitter(
    content: string,
    filePath: string,
    language: TreeSitterLanguage,
    repoId: string,
  ): Chunk[] {
    const parser = this.treeSitter.getParser(language);
    if (!parser) return [];

    const tree = parser.parse(content);
    if (!tree) return [];

    try {
      const root = tree.rootNode;
      const nodes = root.descendantsOfType(nodeTypesForLanguage(language));

      const chunks: Chunk[] = [];

      for (const node of nodes) {
        const symbolKind = symbolKindFromNodeType(node.type);
        if (!symbolKind) continue;

        const nameNode = node.childForFieldName("name");
        const symbolName = nameNode?.text?.trim();
        if (!symbolName) continue;

        const snippet = node.text?.trim();
        if (!snippet) continue;

        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;

        const parentSymbol = symbolKind === "method"
          ? findNearestClassName(node.parent)
          : undefined;

        chunks.push({
          id: makeChunkId(filePath, startLine, endLine, snippet, symbolName, symbolKind),
          content: snippet,
          filePath,
          startLine,
          endLine,
          language,
          repoId,
          symbolName,
          symbolKind,
          parentSymbol,
        });
      }

      return chunks;
    } finally {
      tree.delete();
    }
  }

  private chunkTsJs(content: string, filePath: string, language: string, repoId: string): Chunk[] {
    const scriptKind = language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

    const chunks: Chunk[] = [];

    const visit = (node: ts.Node, parentClass?: string) => {
      const chunk = this.createTsChunk(source, content, node, filePath, language, repoId, parentClass);
      if (chunk) chunks.push(chunk);

      const nextParent = ts.isClassDeclaration(node) && node.name
        ? node.name.text
        : parentClass;

      ts.forEachChild(node, (child) => visit(child, nextParent));
    };

    visit(source);

    return dedupeChunks(chunks);
  }

  private createTsChunk(
    source: ts.SourceFile,
    content: string,
    node: ts.Node,
    filePath: string,
    language: string,
    repoId: string,
    parentClass?: string,
  ): Chunk | null {
    let symbolName: string | undefined;
    let symbolKind: SymbolKind | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) {
      symbolName = node.name.text;
      symbolKind = "function";
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbolName = node.name.text;
      symbolKind = "class";
    } else if (ts.isMethodDeclaration(node) && node.name) {
      symbolName = node.name.getText(source);
      symbolKind = "method";
    } else if (ts.isInterfaceDeclaration(node)) {
      symbolName = node.name.text;
      symbolKind = "interface";
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbolName = node.name.text;
      symbolKind = "type";
    } else if (ts.isEnumDeclaration(node)) {
      symbolName = node.name.text;
      symbolKind = "enum";
    }

    if (!symbolName || !symbolKind) return null;

    const startPos = node.getStart(source);
    const endPos = node.getEnd();
    const start = source.getLineAndCharacterOfPosition(startPos).line + 1;
    const end = source.getLineAndCharacterOfPosition(endPos).line + 1;

    const snippet = content.slice(startPos, endPos).trim();
    if (!snippet) return null;

    return {
      id: makeChunkId(filePath, start, end, snippet, symbolName, symbolKind),
      content: snippet,
      filePath,
      startLine: start,
      endLine: end,
      language,
      repoId,
      symbolName,
      symbolKind,
      parentSymbol: symbolKind === "method" ? parentClass : undefined,
    };
  }

  private chunkPython(content: string, filePath: string, repoId: string): Chunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
      const fnMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);

      if (!classMatch && !fnMatch) continue;

      const symbolName = classMatch?.[1] ?? fnMatch?.[1] ?? "unknown";
      const symbolKind: SymbolKind = classMatch ? "class" : "function";

      const baseIndent = indentation(line);
      let end = i;

      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (!candidate.trim()) {
          end = j;
          continue;
        }

        const ind = indentation(candidate);
        if (ind <= baseIndent && !candidate.trimStart().startsWith("#")) {
          break;
        }
        end = j;
      }

      const snippet = lines.slice(i, end + 1).join("\n").trim();
      if (!snippet) continue;

      const startLine = i + 1;
      const endLine = end + 1;

      chunks.push({
        id: makeChunkId(filePath, startLine, endLine, snippet, symbolName, symbolKind),
        content: snippet,
        filePath,
        startLine,
        endLine,
        language: "python",
        repoId,
        symbolName,
        symbolKind,
      });
    }

    return dedupeChunks(chunks);
  }
}

function nodeTypesForLanguage(language: TreeSitterLanguage): string[] {
  switch (language) {
    case "typescript":
      return [
        "function_declaration",
        "class_declaration",
        "method_definition",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
      ];
    case "javascript":
      return ["function_declaration", "class_declaration", "method_definition"];
    case "python":
      return ["function_definition", "class_definition"];
  }
}

function symbolKindFromNodeType(type: string): SymbolKind | null {
  switch (type) {
    case "function_declaration":
    case "function_definition":
      return "function";
    case "class_declaration":
    case "class_definition":
      return "class";
    case "method_definition":
      return "method";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    default:
      return null;
  }
}

function findNearestClassName(node: any): string | undefined {
  let cursor = node;
  while (cursor) {
    if (cursor.type === "class_declaration") {
      const nameNode = cursor.childForFieldName?.("name");
      if (nameNode?.text) return nameNode.text;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

function isTreeSitterLanguage(lang: string): lang is TreeSitterLanguage {
  return lang === "typescript" || lang === "javascript" || lang === "python";
}

function makeChunkId(
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  symbolName: string,
  symbolKind: SymbolKind,
): string {
  const hash = createHash("sha1")
    .update(filePath)
    .update(":")
    .update(String(startLine))
    .update(":")
    .update(String(endLine))
    .update(":")
    .update(symbolKind)
    .update(":")
    .update(symbolName)
    .update(":")
    .update(content)
    .digest("hex")
    .slice(0, 16);

  return `${filePath}:${startLine}-${endLine}:${symbolKind}:${symbolName}:${hash}`;
}

function indentation(line: string): number {
  const m = line.match(/^\s*/);
  return m?.[0].length ?? 0;
}

function dedupeChunks(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  const out: Chunk[] = [];

  for (const chunk of chunks) {
    const key = `${chunk.filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.symbolKind}:${chunk.symbolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }

  return out;
}
