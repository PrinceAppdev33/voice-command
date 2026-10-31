import { handleUnderstandRequest } from "../server.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function understand(request, response) {
  await handleUnderstandRequest(request, response);
}
