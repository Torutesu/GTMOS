import seed from "./data/seed.json";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  pending?: boolean;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  owner: string;
  due: string;
  tag: string;
}

const SESSION_KEY = "taskloop.session";

export const STATUSES = ["Todo", "In progress", "In review", "Done"] as const;

/** In-memory store seeded from JSON. A demo needs plausible data, not a database. */
let members: Member[] = [...(seed.members as Member[])];
let tasks: Task[] = [...(seed.tasks as Task[])];

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const workspaceName = (): string =>
  (import.meta.env?.["VITE_WORKSPACE_NAME"] as string | undefined) ?? seed.workspace;

export const getMembers = (): Member[] => members;
export const getTasks = (): Task[] => tasks;
export const getThroughput = () => seed.throughput;

export function memberById(id: string): Member | undefined {
  return members.find((m) => m.id === id);
}

export function addTask(input: { title: string; owner: string; due: string; tag: string }): Task {
  const nextNum = 200 + tasks.length;
  const task: Task = {
    id: `T-${nextNum}`,
    title: input.title,
    status: "Todo",
    owner: input.owner,
    due: input.due,
    tag: input.tag || "General",
  };
  tasks = [task, ...tasks];
  notify();
  return task;
}

export function inviteMember(email: string, role: string): Member {
  const namePart = email.split("@")[0] ?? "new";
  const member: Member = {
    id: `u${members.length + 1}`,
    name: namePart.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    email,
    role,
    initials: namePart.slice(0, 2).toUpperCase(),
    pending: true,
  };
  members = [...members, member];
  notify();
  return member;
}

/* ------------------------------- session -------------------------------- */

export function signIn(email: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ email, at: Date.now() }));
}

export function signOut(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function currentUser(): { email: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { email: string }) : null;
  } catch {
    return null;
  }
}
