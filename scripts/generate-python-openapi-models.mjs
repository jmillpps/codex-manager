import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const openApiPath = path.join(root, "apps", "api", "openapi", "openapi.json");
const outputDir = path.join(root, "packages", "python-client", "src", "codex_manager", "generated");
const outputModelsPath = path.join(outputDir, "openapi_models.py");
const outputInitPath = path.join(outputDir, "__init__.py");

const pythonKeywords = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield"
]);

function refNameFromSchema(schema) {
  const ref = schema?.$ref;
  if (typeof ref !== "string") {
    return null;
  }
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    return null;
  }
  return ref.slice(prefix.length);
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toPythonIdentifier(value) {
  const base = snakeCase(value);
  let next = base.length > 0 ? base : "field_value";
  if (!/^[a-zA-Z_]/.test(next)) {
    next = `field_${next}`;
  }
  if (pythonKeywords.has(next)) {
    next = `${next}_`;
  }
  return next;
}

function literalValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "None";
  }
  return "None";
}

function includesNone(typeText) {
  return typeText.includes("None");
}

function toType(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "Any";
  }

  const reference = refNameFromSchema(schema);
  if (reference) {
    return reference;
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (anyOf.length > 0) {
    const members = [...new Set(anyOf.map((item) => toType(item)).filter((item) => item.length > 0))];
    return members.length > 0 ? members.join(" | ") : "Any";
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (oneOf.length > 0) {
    const members = [...new Set(oneOf.map((item) => toType(item)).filter((item) => item.length > 0))];
    return members.length > 0 ? members.join(" | ") : "Any";
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  const literalPart = enumValues.length > 0 ? `Literal[${enumValues.map((value) => literalValue(value)).join(", ")}]` : null;

  const schemaType = schema.type;
  const explicitTypes = Array.isArray(schemaType) ? [...schemaType] : typeof schemaType === "string" ? [schemaType] : [];
  const nullable = explicitTypes.includes("null");
  const nonNullTypes = explicitTypes.filter((typeName) => typeName !== "null");

  let baseType;
  if (literalPart) {
    baseType = literalPart;
  } else if (nonNullTypes.length === 0 && explicitTypes.length > 0) {
    baseType = "Any";
  } else {
    const primaryType = nonNullTypes[0];
    if (primaryType === "string") {
      baseType = "str";
    } else if (primaryType === "integer") {
      baseType = "int";
    } else if (primaryType === "number") {
      baseType = "float";
    } else if (primaryType === "boolean") {
      baseType = "bool";
    } else if (primaryType === "array") {
      baseType = `list[${toType(schema.items)}]`;
    } else if (primaryType === "object" || schema.properties || Object.hasOwn(schema, "additionalProperties")) {
      const additionalProperties = schema.additionalProperties;
      if (additionalProperties && typeof additionalProperties === "object" && !Array.isArray(additionalProperties)) {
        baseType = `dict[str, ${toType(additionalProperties)}]`;
      } else {
        baseType = "dict[str, Any]";
      }
    } else {
      baseType = "Any";
    }
  }

  if (nullable && !includesNone(baseType)) {
    return `${baseType} | None`;
  }
  return baseType;
}

function isObjectSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return false;
  }
  if (schema.type === "object") {
    return true;
  }
  if (schema.properties && typeof schema.properties === "object") {
    return true;
  }
  if (Object.hasOwn(schema, "additionalProperties")) {
    return true;
  }
  return false;
}

function isUnionSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  return (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) || (Array.isArray(schema.anyOf) && schema.anyOf.length > 0);
}

function isAliasSchema(schema) {
  return !isObjectSchema(schema) && !isUnionSchema(schema);
}

function buildClass(name, schema) {
  const lines = [];
  const additionalProperties = schema?.additionalProperties;
  const extraMode = additionalProperties === false ? "forbid" : "allow";
  const usedFieldNames = new Set();

  lines.push(`class ${name}(BaseModel):`);
  lines.push(`    model_config = ConfigDict(populate_by_name=True, extra="${extraMode}")`);

  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const propertyNames = Object.keys(properties);

  if (propertyNames.length === 0) {
    lines.push("    pass");
    return lines;
  }

  for (const originalName of propertyNames) {
    const fieldSchema = properties[originalName];
    const requiredField = required.has(originalName);
    let fieldType = toType(fieldSchema);
    if (!requiredField && !includesNone(fieldType)) {
      fieldType = `${fieldType} | None`;
    }

    const basePythonName = toPythonIdentifier(originalName);
    let pythonName = basePythonName;
    if (usedFieldNames.has(pythonName)) {
      let counter = 2;
      while (usedFieldNames.has(`${basePythonName}_${counter}`)) {
        counter += 1;
      }
      pythonName = `${basePythonName}_${counter}`;
    }
    usedFieldNames.add(pythonName);
    const needsAlias = pythonName !== originalName;

    let defaultValue = requiredField ? "..." : "None";
    if (needsAlias) {
      defaultValue = requiredField ? `Field(..., alias="${originalName}")` : `Field(None, alias="${originalName}")`;
    }

    lines.push(`    ${pythonName}: ${fieldType} = ${defaultValue}`);
  }

  return lines;
}

function buildAlias(name, schema) {
  const typeText = toType(schema);
  return `${name}: TypeAlias = ${typeText}`;
}

function buildUnionAlias(name, schema) {
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const members = [...new Set(variants.map((item) => toType(item)).filter((item) => item.length > 0))];
  const typeText = members.length > 0 ? members.join(" | ") : "Any";
  return `${name}: TypeAlias = ${typeText}`;
}

function renderModule(componentsSchemas) {
  const schemaNames = Object.keys(componentsSchemas).sort();
  const aliasNames = schemaNames.filter((name) => isAliasSchema(componentsSchemas[name]));
  const classNames = schemaNames.filter((name) => isObjectSchema(componentsSchemas[name]));
  const unionNames = schemaNames.filter((name) => isUnionSchema(componentsSchemas[name]));

  const lines = [];
  lines.push('"""Generated OpenAPI-backed pydantic models for codex-manager.');
  lines.push("");
  lines.push("Do not edit this file manually. Regenerate with:");
  lines.push("`pnpm python:openapi:gen`");
  lines.push('"""');
  lines.push("");
  lines.push("from __future__ import annotations");
  lines.push("");
  lines.push("from typing import Any, Literal, TypeAlias");
  lines.push("");
  lines.push("from pydantic import BaseModel, ConfigDict, Field");
  lines.push("");

  for (const name of aliasNames) {
    lines.push(buildAlias(name, componentsSchemas[name]));
  }

  if (aliasNames.length > 0) {
    lines.push("");
  }

  for (const name of classNames) {
    for (const line of buildClass(name, componentsSchemas[name])) {
      lines.push(line);
    }
    lines.push("");
  }

  for (const name of unionNames) {
    lines.push(buildUnionAlias(name, componentsSchemas[name]));
  }

  if (unionNames.length > 0) {
    lines.push("");
  }

  lines.push("__all__ = [");
  for (const name of [...schemaNames]) {
    lines.push(`    "${name}",`);
  }
  lines.push("]");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function renderInitFile() {
  return [
    '"""Generated OpenAPI model exports."""',
    "",
    "from .openapi_models import *  # noqa: F401,F403",
    "from .openapi_models import __all__",
    ""
  ].join("\n");
}

const openApiDocument = JSON.parse(await readFile(openApiPath, "utf8"));
const componentsSchemas = openApiDocument?.components?.schemas;

if (!componentsSchemas || typeof componentsSchemas !== "object") {
  throw new Error("openapi components/schemas not found; run `pnpm openapi:gen` first");
}

const moduleText = renderModule(componentsSchemas);
const initText = renderInitFile();

await mkdir(outputDir, { recursive: true });
await writeFile(outputModelsPath, moduleText, "utf8");
await writeFile(outputInitPath, initText, "utf8");

console.log(`wrote ${path.relative(root, outputModelsPath)}`);
console.log(`wrote ${path.relative(root, outputInitPath)}`);
