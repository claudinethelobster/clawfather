let runtime: any = null;

export function setClawdfatherRuntime(next: any) {
  runtime = next;
}

export function getClawdfatherRuntime(): any {
  if (!runtime) {
    throw new Error("Clawdfather runtime not initialized");
  }
  return runtime;
}
