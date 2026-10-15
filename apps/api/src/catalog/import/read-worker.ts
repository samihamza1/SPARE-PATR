import type { ReadRequest } from './workbook';
import { handleReadRequest } from './workbook';

// Reader process entry (read.ts): reads one uploaded file and sends the result back. Running
// out of memory or time ends only this process, never the API. It is its own entry in the
// build (tsup.config.ts), next to the server bundle.
process.once('message', (request: ReadRequest) => {
  void handleReadRequest(request).then((response) => {
    process.send?.(response, () => {
      process.disconnect();
    });
  });
});
// The API went away: nobody is waiting for the answer.
process.once('disconnect', () => process.exit(0));
