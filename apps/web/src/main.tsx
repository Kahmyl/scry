import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { ProductApp } from "./app/index.js";
import "./styles/global.css";
import "./app/product-design/product-theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ProductApp />
    </BrowserRouter>
  </StrictMode>,
);
