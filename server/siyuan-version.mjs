export const RIFF_VERSION = '3.8.8';
export const RIFF_SUPPORTED_VERSIONS = Object.freeze(['3.8.8', '3.8.9']);

export const riffCompatible = version => RIFF_SUPPORTED_VERSIONS.includes(version);
