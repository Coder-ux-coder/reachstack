import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; later Tailwind utilities override conflicting earlier ones (e.g. a caller's `w-48` beats `w-full`). */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
