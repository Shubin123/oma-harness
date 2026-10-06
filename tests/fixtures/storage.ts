import { BrowserProjects } from "../../apps/dashboard/src/storage.js";
import * as shared from "@oma/shared";
Object.assign(window, { storageTest: { BrowserProjects, ...shared } });
