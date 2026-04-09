// Mock for expo-file-system (can't run in Node/Jest)
export const documentDirectory = "/mock/documents/";

export const getInfoAsync = jest.fn().mockResolvedValue({ exists: false });
export const makeDirectoryAsync = jest.fn().mockResolvedValue(undefined);
export const readAsStringAsync = jest.fn().mockResolvedValue("{}");
export const writeAsStringAsync = jest.fn().mockResolvedValue(undefined);
export const deleteAsync = jest.fn().mockResolvedValue(undefined);
export const createDownloadResumable = jest.fn().mockReturnValue({
  downloadAsync: jest.fn().mockResolvedValue({ uri: "/mock/model.bin" }),
  resumeAsync: jest.fn().mockResolvedValue({ uri: "/mock/model.bin" }),
  savable: jest.fn().mockReturnValue({}),
});
