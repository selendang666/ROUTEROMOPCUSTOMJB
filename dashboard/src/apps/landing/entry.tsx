import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingPage } from "./page";
import "../../index.css";
import "./landing.css";
import "./base.css";


const root = document.getElementById("root");

if (root === null) {
  throw new Error("Landing root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
