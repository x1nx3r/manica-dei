import { expect, test } from "bun:test"
import { route } from "../src/api/leave"

test("a decision is addressed by request id", () => {
  expect(route("POST", "/leave/lr_1/approve")).toEqual({ kind: "decide", id: "lr_1", decision: "approve" })
  expect(route("POST", "/leave/lr_1/reject")).toEqual({ kind: "decide", id: "lr_1", decision: "reject" })
})

test("the id-less decision path is not routed", () => {
  expect(route("POST", "/leave/approve")).toBeNull()
})

test("creating and reading are routed", () => {
  expect(route("POST", "/leave/request")).toEqual({ kind: "create" })
  expect(route("GET", "/leave/balance")).toEqual({ kind: "balance" })
})

test("the HR queue is routed", () => {
  expect(route("GET", "/leave/queue")).toEqual({ kind: "queue" })
})
