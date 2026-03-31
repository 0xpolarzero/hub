import "./app.css";
import "@mariozechner/pi-web-ui/app.css";
import App from "./App.svelte";
import { mount } from "svelte";

const app = mount(App, {
	target: document.getElementById("app")!,
});

export default app;
