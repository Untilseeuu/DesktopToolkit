import { describe, expect, it } from "vitest";
import template from "../src-tauri/installer.nsi?raw";

describe("NSIS installer upgrade handling", () => {
  it("retires a stale uninstall registration before showing the reinstall page", () => {
    const readRegistration = template.indexOf(
      'ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"',
    );
    const validateUninstaller = template.indexOf(
      'Call RetireStaleNsisRegistration',
      readRegistration,
    );
    const emptyRegistrationCheck = template.indexOf(
      '${IfThen} "$R0$R1" == "" ${|} Abort ${|}',
      readRegistration,
    );

    expect(readRegistration).toBeGreaterThan(-1);
    expect(validateUninstaller).toBeGreaterThan(readRegistration);
    expect(emptyRegistrationCheck).toBeGreaterThan(validateUninstaller);
    expect(template).toContain('IfFileExists "$R2" stale_registration_done');
    expect(template).toContain('DeleteRegKey SHCTX "${UNINSTKEY}"');
    expect(template).toContain('DeleteRegKey /ifempty SHCTX "${MANUPRODUCTKEY}"');
  });
});
