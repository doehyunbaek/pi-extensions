import { getGcloudToken } from "./gcloud-token.js";

const token = await getGcloudToken();
if (token) {
  process.stdout.write(token);
} else {
  process.exitCode = 1;
}
