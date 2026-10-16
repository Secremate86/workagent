import { NextResponse } from "next/server";
import { OfficeError } from "./workspace";

export function officeErrorResponse(error: unknown) {
  const known = error instanceof OfficeError;
  return NextResponse.json({ ok: false, code: known ? error.code : "INTERNAL_ERROR", error: error instanceof Error ? error.message : String(error) }, { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
