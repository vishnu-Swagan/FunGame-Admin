import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";
import { enforceCanonicalAdminBrowserLocation } from "@/lib/adminConsole";
import { installViewportMetrics } from "@/lib/viewport";

// Redirect legacy browser admin entries before mounting React. The Sites
// reverse proxy is server-side and therefore does not execute this branch;
// once its response reaches the browser, window.location is chakri.casino.
if (!enforceCanonicalAdminBrowserLocation(window.location)) {
  // Install once for the lifetime of the PWA. Every fullscreen game consumes
  // the same live viewport rectangle through CSS variables.
  installViewportMetrics();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });

  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
