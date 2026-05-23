import React from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { SecurityKeysScreen } from "../SecurityKeysScreen";

const mockGoBack = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));
jest.mock("expo-linear-gradient", () => ({
  LinearGradient: ({ children }: any) => children,
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));
jest.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ deviceId: "test-device-id" }),
}));
jest.mock("../../../context/ThemeContext", () => ({
  useTheme: () => ({
    getThemeColors: () => ({
      background: {
        gradient: ["#000", "#111"],
        primary: "#000",
        secondary: "#111",
      },
      text: { primary: "#fff", secondary: "#aaa", tertiary: "#555" },
      primary: "#6200ee",
    }),
    getFontSize: () => 16,
    getLocalizedText: (key: string) => key,
  }),
}));
jest.mock("../../../components/Toast/Toast", () => () => null);
jest.mock("../../../utils/clipboard", () => ({
  copyToClipboard: jest.fn(),
}));
jest.mock("react-native-qrcode-styled", () => () => null);

const mockListDevices = jest.fn();
const mockRevokeDevice = jest.fn();
const mockGenerateQRChallenge = jest.fn();
jest.mock("../../../services/SecurityService", () => ({
  DeviceManagerService: {
    listDevices: (...a: unknown[]) => mockListDevices(...a),
    revokeDevice: (...a: unknown[]) => mockRevokeDevice(...a),
    generateQRChallenge: (...a: unknown[]) => mockGenerateQRChallenge(...a),
  },
}));

describe("SecurityKeysScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDevices.mockResolvedValue([]);
    mockGenerateQRChallenge.mockResolvedValue("jwt-challenge-token");
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("renders without crashing", () => {
    const { toJSON } = render(<SecurityKeysScreen />);
    expect(toJSON()).toBeTruthy();
  });

  it("fetches device list on mount", async () => {
    render(<SecurityKeysScreen />);
    await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
  });

  it("renders devices returned by the API", async () => {
    mockListDevices.mockResolvedValue([
      {
        id: "test-device-id",
        deviceName: "Mon iPhone",
        deviceType: "ios",
        lastActive: new Date().toISOString(),
        isVerified: true,
        isActive: true,
      },
    ]);
    const { findByText } = render(<SecurityKeysScreen />);
    expect(await findByText("Mon iPhone")).toBeTruthy();
  });

  it("opens QR modal and calls generateQRChallenge when QR button pressed", async () => {
    const { getByText } = render(<SecurityKeysScreen />);
    await waitFor(() => expect(mockListDevices).toHaveBeenCalled());

    const qrButton = getByText("security.scanQRCode");
    await act(async () => {
      fireEvent.press(qrButton);
    });

    await waitFor(() =>
      expect(mockGenerateQRChallenge).toHaveBeenCalledWith("test-device-id"),
    );
  });
});
