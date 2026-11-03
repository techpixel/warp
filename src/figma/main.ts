// The Figma plugin's UI: the same editor page as the site, without SvelteKit.
import { mount } from "svelte";
import "#lib/global.css";
import Page from "../routes/+page.svelte";

mount(Page, { target: document.body });
