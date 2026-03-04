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
 *    - Go/Rust/Kotlin via declaration scanners
 */
export class AstChunker implements Chunker {
  private readonly preferTreeSitter: boolean;
  private readonly treeSitter: TreeSitterLoader;

  constructor(options: AstChunkerOptions = {}) {
    this.preferTreeSitter = options.preferTreeSitter ?? true;
    this.treeSitter = options.treeSitterLoader ?? new TreeSitterLoader();
  }

  async warmupTreeSitter(languages: TreeSitterLanguage[] = ["typescript", "javascript", "python", "go", "rust"]): Promise<void> {
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

    if (language === "go") {
      return this.chunkGo(content, filePath, repoId);
    }

    if (language === "rust") {
      return this.chunkRust(content, filePath, repoId);
    }

    if (language === "kotlin") {
      return this.chunkKotlin(content, filePath, repoId);
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
        const info = extractTreeSitterSymbol(node, language);
        if (!info) continue;

        const snippetNode = nodeForChunkContent(node, language);
        const snippet = snippetNode.text?.trim();
        if (!snippet) continue;

        const startLine = snippetNode.startPosition.row + 1;
        const endLine = snippetNode.endPosition.row + 1;

        chunks.push({
          id: makeChunkId(filePath, startLine, endLine, snippet, info.symbolName, info.symbolKind),
          content: snippet,
          filePath,
          startLine,
          endLine,
          language,
          repoId,
          symbolName: info.symbolName,
          symbolKind: info.symbolKind,
          parentSymbol: info.parentSymbol,
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
    const classStack: Array<{ indent: number; name: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      const baseIndent = indentation(line);

      if (trimmed && !trimmed.startsWith("#")) {
        while (classStack.length > 0 && baseIndent <= classStack[classStack.length - 1]!.indent) {
          classStack.pop();
        }
      }

      const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
      const fnMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const constMatch = line.match(/^([A-Z][A-Z0-9_]*)(?:\s*:\s*[^=]+)?\s*=/);
      const allMatch = line.match(/^(__all__)(?:\s*:\s*[^=]+)?\s*=/);

      if (!classMatch && !fnMatch && !constMatch && !allMatch) continue;

      if ((constMatch || allMatch) && baseIndent === 0) {
        const symbolName = allMatch?.[1] ?? constMatch?.[1] ?? "unknown";
        const symbolKind: SymbolKind = "variable";

        const range = allMatch
          ? findPythonAssignmentRange(lines, i, baseIndent)
          : { start: i, end: i };

        const snippet = lines.slice(range.start, range.end + 1).join("\n").trim();
        if (!snippet) continue;

        const startLine = range.start + 1;
        const endLine = range.end + 1;
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
        continue;
      }

      if (!classMatch && !fnMatch) continue;

      const symbolName = classMatch?.[1] ?? fnMatch?.[1] ?? "unknown";
      const symbolKind: SymbolKind = classMatch
        ? "class"
        : (classStack.length > 0 && baseIndent > classStack[classStack.length - 1]!.indent ? "method" : "function");

      const parentSymbol = symbolKind === "method" ? classStack[classStack.length - 1]?.name : undefined;
      const start = findDecoratorStart(lines, i, baseIndent);
      let end = i;

      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j] ?? "";
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

      const snippet = lines.slice(start, end + 1).join("\n").trim();
      if (!snippet) continue;

      const startLine = start + 1;
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
        parentSymbol,
      });

      if (classMatch) {
        classStack.push({ indent: baseIndent, name: symbolName });
      }
    }

    return dedupeChunks(chunks);
  }

  private chunkGo(content: string, filePath: string, repoId: string): Chunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const methodMatch = line.match(/^\s*func\s*\(\s*[A-Za-z_][\w]*\s+\*?([A-Za-z_][\w]*)\s*\)\s+([A-Za-z_][\w]*)\s*\(/);
      const fnMatch = line.match(/^\s*func\s+([A-Za-z_][\w]*)\s*\(/);
      const structMatch = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/);
      const interfaceMatch = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+interface\b/);
      const typeMatch = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+/);

      let symbolName: string | undefined;
      let symbolKind: SymbolKind | undefined;
      let parentSymbol: string | undefined;

      if (methodMatch) {
        parentSymbol = methodMatch[1];
        symbolName = methodMatch[2];
        symbolKind = "method";
      } else if (fnMatch) {
        symbolName = fnMatch[1];
        symbolKind = "function";
      } else if (structMatch) {
        symbolName = structMatch[1];
        symbolKind = "class";
      } else if (interfaceMatch) {
        symbolName = interfaceMatch[1];
        symbolKind = "interface";
      } else if (typeMatch) {
        symbolName = typeMatch[1];
        symbolKind = "type";
      }

      if (!symbolName || !symbolKind) continue;

      const startLine = i + 1;
      const endLine = i + 1;
      const snippet = line.trim();
      if (!snippet) continue;

      chunks.push({
        id: makeChunkId(filePath, startLine, endLine, snippet, symbolName, symbolKind),
        content: snippet,
        filePath,
        startLine,
        endLine,
        language: "go",
        repoId,
        symbolName,
        symbolKind,
        parentSymbol,
      });
    }

    return dedupeChunks(chunks);
  }

  private chunkRust(content: string, filePath: string, repoId: string): Chunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const structMatch = line.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/);
      const enumMatch = line.match(/^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/);
      const traitMatch = line.match(/^\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)\b/);
      const fnMatch = line.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/);

      let symbolName: string | undefined;
      let symbolKind: SymbolKind | undefined;

      if (structMatch) {
        symbolName = structMatch[1];
        symbolKind = "class";
      } else if (enumMatch) {
        symbolName = enumMatch[1];
        symbolKind = "enum";
      } else if (traitMatch) {
        symbolName = traitMatch[1];
        symbolKind = "interface";
      } else if (fnMatch) {
        symbolName = fnMatch[1];
        symbolKind = "function";
      }

      if (!symbolName || !symbolKind) continue;

      const startLine = i + 1;
      const endLine = i + 1;
      const snippet = line.trim();
      if (!snippet) continue;

      chunks.push({
        id: makeChunkId(filePath, startLine, endLine, snippet, symbolName, symbolKind),
        content: snippet,
        filePath,
        startLine,
        endLine,
        language: "rust",
        repoId,
        symbolName,
        symbolKind,
      });
    }

    return dedupeChunks(chunks);
  }

  private chunkKotlin(content: string, filePath: string, repoId: string): Chunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(/^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_][\w]*)\b/);
      const interfaceMatch = line.match(/^\s*(?:sealed\s+)?interface\s+([A-Za-z_][\w]*)\b/);
      const objectMatch = line.match(/^\s*object\s+([A-Za-z_][\w]*)\b/);
      const typeAliasMatch = line.match(/^\s*typealias\s+([A-Za-z_][\w]*)\b/);
      const fnMatch = line.match(/^\s*(?:suspend\s+)?fun\s+(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s*\(/);

      let symbolName: string | undefined;
      let symbolKind: SymbolKind | undefined;

      if (classMatch) {
        symbolName = classMatch[1];
        symbolKind = "class";
      } else if (interfaceMatch) {
        symbolName = interfaceMatch[1];
        symbolKind = "interface";
      } else if (objectMatch) {
        symbolName = objectMatch[1];
        symbolKind = "class";
      } else if (typeAliasMatch) {
        symbolName = typeAliasMatch[1];
        symbolKind = "type";
      } else if (fnMatch) {
        symbolName = fnMatch[1];
        symbolKind = "function";
      }

      if (!symbolName || !symbolKind) continue;

      const startLine = i + 1;
      const endLine = i + 1;
      const snippet = line.trim();
      if (!snippet) continue;

      chunks.push({
        id: makeChunkId(filePath, startLine, endLine, snippet, symbolName, symbolKind),
        content: snippet,
        filePath,
        startLine,
        endLine,
        language: "kotlin",
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
      return ["decorated_definition", "function_definition", "class_definition", "assignment"];
    case "go":
      return ["function_declaration", "method_declaration", "type_spec"];
    case "rust":
      return ["struct_item", "enum_item", "trait_item", "function_item", "function_signature_item"];
    case "kotlin":
      return ["class_declaration", "interface_declaration", "function_declaration", "type_alias", "object_declaration"];
  }
}

function extractTreeSitterSymbol(
  node: any,
  language: TreeSitterLanguage,
): { symbolName: string; symbolKind: SymbolKind; parentSymbol?: string } | null {
  switch (language) {
    case "typescript":
    case "javascript": {
      const symbolKind = symbolKindFromNodeType(node.type);
      if (!symbolKind) return null;

      const nameNode = node.childForFieldName("name");
      const symbolName = nameNode?.text?.trim();
      if (!symbolName) return null;

      return {
        symbolName,
        symbolKind,
        parentSymbol: symbolKind === "method" ? findNearestClassName(node.parent) : undefined,
      };
    }

    case "python": {
      return extractPythonTreeSitterSymbol(node);
    }

    case "go": {
      if (node.type === "function_declaration") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        return { symbolName: name, symbolKind: "function" };
      }

      if (node.type === "method_declaration") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        return {
          symbolName: name,
          symbolKind: "method",
          parentSymbol: findGoReceiverType(node),
        };
      }

      if (node.type === "type_spec") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        const kind = symbolKindForGoTypeSpec(node);
        return { symbolName: name, symbolKind: kind };
      }

      return null;
    }

    case "rust": {
      if (node.type === "struct_item") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        return { symbolName: name, symbolKind: "class" };
      }

      if (node.type === "enum_item") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        return { symbolName: name, symbolKind: "enum" };
      }

      if (node.type === "trait_item") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;
        return { symbolName: name, symbolKind: "interface" };
      }

      if (node.type === "function_item" || node.type === "function_signature_item") {
        const name = node.childForFieldName("name")?.text?.trim();
        if (!name) return null;

        const implParent = findNearestAncestor(node.parent, "impl_item");
        if (implParent) {
          const implType = implParent.childForFieldName("type")?.text?.trim();
          return {
            symbolName: name,
            symbolKind: "method",
            parentSymbol: implType || undefined,
          };
        }

        const traitParent = findNearestAncestor(node.parent, "trait_item");
        if (traitParent) {
          const traitName = traitParent.childForFieldName("name")?.text?.trim();
          return {
            symbolName: name,
            symbolKind: "method",
            parentSymbol: traitName || undefined,
          };
        }

        return { symbolName: name, symbolKind: "function" };
      }

      return null;
    }

    case "kotlin": {
      const name = node.childForFieldName("name")?.text?.trim();
      if (!name) return null;

      if (node.type === "class_declaration" || node.type === "object_declaration") {
        return { symbolName: name, symbolKind: "class" };
      }

      if (node.type === "interface_declaration") {
        return { symbolName: name, symbolKind: "interface" };
      }

      if (node.type === "type_alias") {
        return { symbolName: name, symbolKind: "type" };
      }

      if (node.type === "function_declaration") {
        const classParent = findNearestAncestor(node.parent, "class_declaration")
          ?? findNearestAncestor(node.parent, "object_declaration")
          ?? findNearestAncestor(node.parent, "interface_declaration");

        const parentSymbol = classParent?.childForFieldName("name")?.text?.trim();

        return {
          symbolName: name,
          symbolKind: parentSymbol ? "method" : "function",
          parentSymbol: parentSymbol || undefined,
        };
      }

      return null;
    }
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

function symbolKindForGoTypeSpec(node: any): SymbolKind {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return "type";

  if (typeNode.type === "struct_type") return "class";
  if (typeNode.type === "interface_type") return "interface";
  return "type";
}

function findGoReceiverType(node: any): string | undefined {
  const receiver = node.childForFieldName?.("receiver");
  if (!receiver) return undefined;

  const identifiers = receiver.descendantsOfType?.(["type_identifier"]);
  if (Array.isArray(identifiers) && identifiers.length > 0) {
    return identifiers[identifiers.length - 1]?.text?.trim() || undefined;
  }

  return undefined;
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

function findNearestAncestor(node: any, type: string): any | null {
  let cursor = node;
  while (cursor) {
    if (cursor.type === type) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function nodeForChunkContent(node: any, language: TreeSitterLanguage): any {
  if (language === "python" && (node.type === "class_definition" || node.type === "function_definition")) {
    if (node.parent?.type === "decorated_definition") {
      return node.parent;
    }
  }

  return node;
}

function extractPythonTreeSitterSymbol(
  node: any,
): { symbolName: string; symbolKind: SymbolKind; parentSymbol?: string } | null {
  if (!node) return null;

  if (node.type === "decorated_definition") {
    const decorated = node.childForFieldName?.("definition")
      ?? node.childForFieldName?.("body")
      ?? firstChildByTypes(node, ["function_definition", "class_definition"]);

    if (!decorated) return null;

    return extractPythonTreeSitterSymbol(decorated);
  }

  if (node.type === "assignment") {
    const parentExpr = node.parent?.type === "expression_statement" ? node.parent : null;
    const isModuleLevel = parentExpr?.parent?.type === "module";
    if (!isModuleLevel) return null;

    const lhs = node.child(0);
    if (!lhs || lhs.type !== "identifier") return null;

    const symbolName = lhs.text?.trim();
    if (!symbolName) return null;

    if (symbolName !== "__all__" && !/^[A-Z][A-Z0-9_]*$/.test(symbolName)) {
      return null;
    }

    return {
      symbolName,
      symbolKind: "variable",
    };
  }

  const baseKind = symbolKindFromNodeType(node.type);
  if (!baseKind) return null;

  const nameNode = node.childForFieldName("name");
  const symbolName = nameNode?.text?.trim();
  if (!symbolName) return null;

  if (baseKind === "function") {
    const parentClass = findNearestAncestor(node.parent, "class_definition");
    if (parentClass) {
      const className = parentClass.childForFieldName("name")?.text?.trim();
      return {
        symbolName,
        symbolKind: "method",
        parentSymbol: className || undefined,
      };
    }
  }

  return {
    symbolName,
    symbolKind: baseKind,
  };
}

function firstChildByTypes(node: any, types: string[]): any | null {
  if (!node) return null;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (types.includes(child.type)) return child;
  }

  return null;
}

function isTreeSitterLanguage(lang: string): lang is TreeSitterLanguage {
  return lang === "typescript" || lang === "javascript" || lang === "python" || lang === "go" || lang === "rust" || lang === "kotlin";
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

function findDecoratorStart(lines: string[], declarationLineIndex: number, declarationIndent: number): number {
  let start = declarationLineIndex;

  for (let i = declarationLineIndex - 1; i >= 0; i--) {
    const candidate = lines[i] ?? "";
    if (!candidate.trim()) {
      continue;
    }

    if (indentation(candidate) !== declarationIndent) {
      break;
    }

    if (candidate.trimStart().startsWith("@")) {
      start = i;
      continue;
    }

    break;
  }

  return start;
}

function findPythonAssignmentRange(
  lines: string[],
  startIndex: number,
  assignmentIndent: number,
): { start: number; end: number } {
  let end = startIndex;
  let balance = bracketBalance(lines[startIndex] ?? "");
  let continuation = /\\\s*$/.test((lines[startIndex] ?? "").trimEnd());

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      end = i;
      continue;
    }

    const indent = indentation(line);

    if (balance <= 0 && !continuation && indent <= assignmentIndent) {
      break;
    }

    end = i;
    balance += bracketBalance(line);
    continuation = /\\\s*$/.test(trimmed);
  }

  return { start: startIndex, end };
}

function bracketBalance(line: string): number {
  let delta = 0;

  for (const ch of line) {
    if (ch === "[" || ch === "(" || ch === "{") delta += 1;
    if (ch === "]" || ch === ")" || ch === "}") delta -= 1;
  }

  return delta;
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
