import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { queryClient } from "@/lib/query";
import { applyTheme, savedTheme } from "@/lib/theme";
import { ConfirmProvider, TooltipProvider } from "@/components/ui";
import { router } from "./router";
import "./index.css";

applyTheme(savedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <ConfirmProvider>
          <RouterProvider router={router} />
          {/* Top center: the bottom edge holds sticky save bars whose buttons a toast would cover. */}
          <Toaster position="top-center" richColors closeButton toastOptions={{ className: "text-sm" }} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
