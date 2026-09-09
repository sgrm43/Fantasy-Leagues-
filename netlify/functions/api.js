import { handleApiRequest } from '../../src/api-router.js';

const FUNCTION_PATH = '/.netlify/functions/api';

export default async function api(request) {
  return handleApiRequest(normalizeRequest(request));
}

export const config = {};

export function normalizeRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === FUNCTION_PATH || url.pathname.startsWith(`${FUNCTION_PATH}/`)) {
    url.pathname = `/api${url.pathname.slice(FUNCTION_PATH.length) || '/'}`;
    return new Request(url, request);
  }
  return request;
}
