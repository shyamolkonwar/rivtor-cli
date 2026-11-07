import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./envfile.js";

describe("parseEnvFile", () => {
  it("parses common dotenv syntax", () => {
    const text = [
      "# comment",
      "",
      "PLAIN=value",
      "export EXPORTED=yes",
      "SPACED = padded  ",
      "EMPTY=",
      "INLINE=foo # a comment",
      "HASH_IN_VALUE=abc#def",
      "SINGLE='single # not comment'",
      'DOUBLE="line1\\nline2 \\"q\\""',
      'MULTI="first',
      'second"',
      "BACKTICK=`tick`",
      "URL=postgres://u:p@h:5432/db?sslmode=require",
      "not a valid line",
      "WIN=crlf\r",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      PLAIN: "value",
      EXPORTED: "yes",
      SPACED: "padded",
      EMPTY: "",
      INLINE: "foo",
      HASH_IN_VALUE: "abc#def",
      SINGLE: "single # not comment",
      DOUBLE: 'line1\nline2 "q"',
      MULTI: "first\nsecond",
      BACKTICK: "tick",
      URL: "postgres://u:p@h:5432/db?sslmode=require",
      WIN: "crlf",
    });
  });

  it("later keys win and BOM is ignored", () => {
    expect(parseEnvFile("﻿A=1\nA=2")).toEqual({ A: "2" });
  });

  it("keeps escapes literal in single quotes", () => {
    expect(parseEnvFile("A='x\\ny'")).toEqual({ A: "x\\ny" });
  });
});
