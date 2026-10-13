export type Route =
  | { kind: "create" }
  | { kind: "decide"; id: string; decision: "approve" | "reject" }
  | { kind: "balance" }
  | { kind: "queue" }

/** Map a request to a handler. The HTTP surface is a thin shell over the domain. */
export function route(method: string, path: string): Route | null {
  if (method === "POST" && path === "/leave/request") return { kind: "create" }
  if (method === "GET" && path === "/leave/balance") return { kind: "balance" }
  if (method === "GET" && path === "/leave/queue") return { kind: "queue" }
  const decision = /^\/leave\/([^/]+)\/(approve|reject)$/.exec(path)
  if (method === "POST" && decision) {
    return { kind: "decide", id: decision[1]!, decision: decision[2] as "approve" | "reject" }
  }
  return null
}
