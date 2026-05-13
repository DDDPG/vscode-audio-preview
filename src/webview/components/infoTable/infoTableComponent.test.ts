import InfoTableComponent from "./infoTableComponent";

describe("infoTableComponent", () => {
  let infoTableComponent: InfoTableComponent;
  beforeAll(() => {
    document.body.innerHTML = '<div id="info-table"></div>';
    infoTableComponent = new InfoTableComponent("#info-table");
  });

  test("show encoding", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 16);
    expect(
      document.querySelector(".js-infoTableData-encoding")?.textContent,
    ).toBe("pcm_s16le");
  });

  test("show format", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 16);
    expect(
      document.querySelector(".js-infoTableData-format")?.textContent,
    ).toBe("s16");
  });

  test("show number of channel (mono)", () => {
    infoTableComponent.showInfo(1, 44100, 1, "s16", "pcm_s16le", 24);
    expect(
      document.querySelector(".js-infoTableData-number_of_channel")
        ?.textContent,
    ).toBe("1 ch (mono)");
  });

  test("show number of channel (stereo)", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 16);
    expect(
      document.querySelector(".js-infoTableData-number_of_channel")
        ?.textContent,
    ).toBe("2 ch (stereo)");
  });

  test("show sample rate", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 16);
    expect(
      document.querySelector(".js-infoTableData-sample_rate")?.textContent,
    ).toBe("44,100 Hz");
  });

  test("show bit depth when known", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 24);
    expect(
      document.querySelector(".js-infoTableData-bit_depth")?.textContent,
    ).toBe("24 bit");
  });

  test("show bit depth placeholder when unknown", () => {
    infoTableComponent.showInfo(2, 44100, 1, "MP3", "PCM", null);
    expect(
      document.querySelector(".js-infoTableData-bit_depth")?.textContent,
    ).toBe("—");
  });

  test("show file size", () => {
    infoTableComponent.showInfo(2, 44100, 1, "s16", "pcm_s16le", 16);
    expect(
      document.querySelector(".js-infoTableData-file_size")?.textContent,
    ).toBe("1 bytes");
  });

  test("show duration", () => {
    infoTableComponent.showAdditionalInfo(12.34);
    expect(
      document.querySelector(".js-infoTableData-duration")?.textContent,
    ).toBe("12.3 s");
  });

  afterAll(() => {
    infoTableComponent.dispose();
  });
});
