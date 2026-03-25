const { HOST, MAX_UPLOAD_MB, PORT, STORAGE_CAP_MB } = require("./backend/config");
const { closeResources, startServer } = require("./backend/app");

if (require.main === module) {
  startServer()
    .then((server) => {
      const address = server.address();
      console.log(
        `ClosetVault is running on http://${address.address}:${address.port} with ${MAX_UPLOAD_MB} MB uploads and ${STORAGE_CAP_MB} MB of vault storage.`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  closeResources,
  startServer,
};
