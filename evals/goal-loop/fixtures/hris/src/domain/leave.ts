export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled"

export type LeaveRequest = {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  days: number
  status: LeaveStatus
  decidedBy?: string | null
  decidedAt?: string | null
}

export type EmployeeRef = { id: string; managerId?: string | null }

export function approve(request: LeaveRequest, approver: EmployeeRef, employee: EmployeeRef, at: string): LeaveRequest {
  if (request.status !== "pending") throw new Error(`cannot approve a ${request.status} request`)
  if (!employee.managerId || employee.managerId !== approver.id) {
    throw new Error("only the reporting manager can approve this request")
  }
  return { ...request, status: "approved", decidedBy: approver.id, decidedAt: at }
}

export function reject(request: LeaveRequest, approver: EmployeeRef, employee: EmployeeRef, at: string): LeaveRequest {
  if (request.status !== "pending") throw new Error(`cannot reject a ${request.status} request`)
  if (!employee.managerId || employee.managerId !== approver.id) {
    throw new Error("only the reporting manager can reject this request")
  }
  return { ...request, status: "rejected", decidedBy: approver.id, decidedAt: at }
}

export function cancel(request: LeaveRequest): LeaveRequest {
  if (request.status !== "pending") throw new Error(`cannot cancel a ${request.status} request`)
  return { ...request, status: "cancelled" }
}
