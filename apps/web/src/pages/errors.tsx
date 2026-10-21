import type { ReactNode } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Compass, TriangleAlert } from "lucide-react";
import { errorMessage, isNotFound } from "@/lib/api";
import { buttonClass } from "@/components/ui";

/** A page that doesn't exist, or a record that's gone (pass what it was and where to go instead). */
export function NotFound({
  title = "Page not found",
  description = "The page you're looking for doesn't exist or was moved.",
  back = { to: "/app/dashboard", label: "Back to the app" },
}: {
  title?: string;
  description?: ReactNode;
  back?: { to: string; label: string };
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 rounded-2xl bg-brand-soft p-3.5 text-brand-text">
        <Compass size={28} />
      </div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">{description}</p>
      <Link to={back.to} className={buttonClass("primary", "md", "mt-6")}>
        {back.label}
      </Link>
    </div>
  );
}

/** A record page whose request failed: "not found" only when the server said so, otherwise the error and a retry. */
export function RecordMissing({ error, retry, notFound }: { error: unknown; retry: () => void; notFound: { title: string; description: ReactNode; back: { to: string; label: string } } }) {
  if (!error || isNotFound(error)) return <NotFound {...notFound} />;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 rounded-2xl bg-bad-soft p-3.5 text-bad">
        <TriangleAlert size={28} />
      </div>
      <h1 className="text-xl font-semibold">Couldn't load this page</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">{errorMessage(error)}</p>
      <button type="button" className={buttonClass("primary", "md", "mt-6")} onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function RouteError() {
  const err = useRouteError();
  if (isRouteErrorResponse(err) && err.status === 404) return <NotFound />;
  // A deploy can replace the lazily-loaded chunks while a tab is open; a reload fetches the new ones.
  const chunkFailed = err instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(err.message);
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 rounded-2xl bg-bad-soft p-3.5 text-bad">
        <TriangleAlert size={28} />
      </div>
      <h1 className="text-xl font-semibold">{chunkFailed ? "A new version is available" : "Something went wrong"}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        {chunkFailed ? "Reload the page to continue." : err instanceof Error ? err.message : "An unexpected error occurred while showing this page."}
      </p>
      <div className="mt-6 flex gap-2">
        <button type="button" className={buttonClass("primary")} onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/app/dashboard" className={buttonClass("secondary")}>
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
