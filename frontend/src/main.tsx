import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

const path = window.location.pathname;
const runIdx = path.indexOf("/run/");
const base = runIdx >= 0 ? path.slice(0, runIdx) : path.replace(/\/$/, "");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={base || undefined}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
