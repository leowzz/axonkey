#include "usb_hid.h"
#include "ch552.h"
#include <string.h>

/* USB DMA buffers in XRAM */
static __xdata __at(0x0000) uint8_t ep0_buf[64];
static __xdata __at(0x0040) uint8_t ep1_buf[128]; /* [0..63] OUT, [64..127] IN */
static __xdata uint8_t serial_str_desc[26];       /* 2 + 12*2 UTF-16LE ("G17-XXXXXXXX") */

static G17_XDATA G17Engine *s_eng = 0;
static volatile uint8_t s_usb_config = 0U;
static volatile uint8_t s_ep1_busy = 0U;
static uint8_t s_usb_addr_pending = 0U;
static uint8_t s_setup_req = 0U;
static uint8_t s_setup_type = 0U;
static uint8_t s_setup_val_l = 0U;
static uint8_t s_setup_val_h = 0U;
static uint16_t s_setup_len = 0U;
static const __code uint8_t *s_descr_ptr = 0;
static uint8_t s_descr_is_xram = 0U;
static __xdata uint8_t *s_xram_ptr = 0;

/* Vendor Raw HID Report Descriptor: Usage Page 0xFF60, Usage 0x01 */
static const __code uint8_t s_hid_report_desc[] = {
    0x06, 0x60, 0xFF, /* Usage Page (Vendor Defined 0xFF60) */
    0x09, 0x01,       /* Usage (0x01) */
    0xA1, 0x01,       /* Collection (Application) */
    /* Input Report 0x01: 7-byte payload (8 bytes on wire with Report ID) */
    0x85, 0x01,       /*   Report ID (1) */
    0x09, 0x01,       /*   Usage (0x01) */
    0x15, 0x00,       /*   Logical Minimum (0) */
    0x26, 0xFF, 0x00, /*   Logical Maximum (255) */
    0x75, 0x08,       /*   Report Size (8) */
    0x95, 0x07,       /*   Report Count (7) */
    0x81, 0x02,       /*   Input (Data,Var,Abs) */
    /* Output Report 0x02: 63-byte payload (64 bytes on wire with Report ID) */
    0x85, 0x02,       /*   Report ID (2) */
    0x09, 0x02,       /*   Usage (0x02) */
    0x95, 0x3F,       /*   Report Count (63) */
    0x91, 0x02,       /*   Output (Data,Var,Abs) */
    /* Feature Report 0x10: 15-byte capabilities payload (16 bytes on wire) */
    0x85, 0x10,       /*   Report ID (0x10) */
    0x09, 0x10,       /*   Usage (0x10) */
    0x95, 0x0F,       /*   Report Count (15) */
    0xB1, 0x02,       /*   Feature (Data,Var,Abs) */
    /* Feature Report 0x11: 7-byte snapshot payload (8 bytes on wire) */
    0x85, 0x11,       /*   Report ID (0x11) */
    0x09, 0x11,       /*   Usage (0x11) */
    0x95, 0x07,       /*   Report Count (7) */
    0xB1, 0x02,       /*   Feature (Data,Var,Abs) */
    /* Feature Report 0x12: 31-byte raw hardware diagnostics (32 bytes on wire) */
    0x85, 0x12,       /*   Report ID (0x12) */
    0x09, 0x12,       /*   Usage (0x12) */
    0x95, 0x1F,       /*   Report Count (31) */
    0xB1, 0x02,       /*   Feature (Data,Var,Abs) */
    0xC0              /* End Collection */
};

static const __code uint8_t s_dev_desc[18] = {
    0x12, 0x01,       /* bLength, DEVICE */
    0x10, 0x01,       /* USB 1.1 */
    0x00, 0x00, 0x00, /* Class/Sub/Proto at interface */
    0x40,             /* EP0 max packet size = 64 */
    0x09, 0x12,       /* VID = 0x1209 */
    0x17, 0xA0,       /* PID = 0xA017 */
    0x00, 0x01,       /* bcdDevice = 1.00 */
    0x01, 0x02, 0x03, /* iManufacturer, iProduct, iSerialNumber */
    0x01              /* bNumConfigurations */
};

static const __code uint8_t s_cfg_desc[41] = {
    0x09, 0x02, 41, 0x00, 0x01, 0x01, 0x00, 0x80, 0x64, /* Config (200mA, no remote-wake sleep hang) */
    0x09, 0x04, 0x00, 0x00, 0x02, 0x03, 0x00, 0x00, 0x00, /* Interface 0: HID */
    0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, sizeof(s_hid_report_desc), 0x00, /* HID Descriptor */
    0x07, 0x05, 0x81, 0x03, 0x40, 0x00, 0x01,             /* EP1 IN: 64B, 1ms */
    0x07, 0x05, 0x01, 0x03, 0x40, 0x00, 0x01              /* EP1 OUT: 64B, 1ms */
};

static const __code uint8_t s_lang_desc[] = {0x04, 0x03, 0x09, 0x04};
static const __code uint8_t s_mfg_desc[] = {
    16, 0x03, 'A', 0, 'x', 0, 'o', 0, 'n', 0, 'k', 0, 'e', 0, 'y', 0
};
static const __code uint8_t s_prod_desc[] = {
    20, 0x03, 'G', 0, '1', 0, '7', 0, ' ', 0, 'T', 0, 'o', 0, 'u', 0, 'c', 0, 'h', 0
};

static void build_serial_descriptor(void) {
    static const __code uint8_t hex[] = "0123456789ABCDEF";
    const __code uint8_t *uid = (const __code uint8_t *)0x3FFCU;
    uint8_t i;
    serial_str_desc[0] = sizeof(serial_str_desc);
    serial_str_desc[1] = 0x03U;
    serial_str_desc[2] = 'G'; serial_str_desc[3] = 0;
    serial_str_desc[4] = '1'; serial_str_desc[5] = 0;
    serial_str_desc[6] = '7'; serial_str_desc[7] = 0;
    serial_str_desc[8] = '-'; serial_str_desc[9] = 0;
    for (i = 0U; i < 4U; ++i) {
        uint8_t b = uid[i];
        serial_str_desc[10U + i * 4U] = hex[(b >> 4) & 0x0FU];
        serial_str_desc[11U + i * 4U] = 0U;
        serial_str_desc[12U + i * 4U] = hex[b & 0x0FU];
        serial_str_desc[13U + i * 4U] = 0U;
    }
}

static uint8_t copy_ep0_chunk(void) {
    uint8_t len = (s_setup_len >= 64U) ? 64U : (uint8_t)s_setup_len;
    uint8_t i;
    if (s_descr_is_xram != 0U) {
        for (i = 0U; i < len; ++i) {
            ep0_buf[i] = s_xram_ptr[i];
        }
        s_xram_ptr += len;
    } else if (s_descr_ptr != 0) {
        for (i = 0U; i < len; ++i) {
            ep0_buf[i] = s_descr_ptr[i];
        }
        s_descr_ptr += len;
    }
    s_setup_len -= len;
    return len;
}

void usb_hid_init(G17_XDATA G17Engine *eng) {
    s_eng = eng;
    build_serial_descriptor();

    IE_USB = 0;
    USB_CTRL = bUC_RESET_SIE | bUC_CLR_ALL;
    USB_CTRL = 0x00U;
    UDEV_CTRL = bUD_PD_DIS;
    USB_DEV_AD = 0x00U;

    UEP4_1_MOD = bUEP1_TX_EN | bUEP1_RX_EN;
    UEP0_DMA_L = (uint8_t)((uint16_t)ep0_buf & 0xFFU);
    UEP0_DMA_H = (uint8_t)((uint16_t)ep0_buf >> 8);
    UEP1_DMA_L = (uint8_t)((uint16_t)ep1_buf & 0xFFU);
    UEP1_DMA_H = (uint8_t)((uint16_t)ep1_buf >> 8);

    UEP0_CTRL = UEP_R_RES_ACK | UEP_T_RES_NAK;
    UEP1_CTRL = bUEP_AUTO_TOG | UEP_R_RES_ACK | UEP_T_RES_NAK;
    UEP1_T_LEN = 0U;

    USB_CTRL = bUC_DEV_PU_EN | bUC_INT_BUSY | bUC_DMA_EN;
    UDEV_CTRL = bUD_PD_DIS | bUD_PORT_EN;
    USB_INT_FG = 0xFFU;
    USB_INT_EN = bUIE_SUSPEND | bUIE_TRANSFER | bUIE_BUS_RST;
    IE_USB = 1;
}

uint8_t usb_hid_is_configured(void) {
    return (s_usb_config != 0U) ? 1U : 0U;
}

uint8_t usb_hid_ep1_ready(void) {
    return (s_usb_config != 0U && s_ep1_busy == 0U) ? 1U : 0U;
}

uint8_t usb_hid_send_input_report(const uint8_t report[8]) {
    uint8_t i;
    if (s_usb_config == 0U || s_ep1_busy != 0U) {
        return 0U;
    }
    for (i = 0U; i < 8U; ++i) {
        ep1_buf[64U + i] = report[i];
    }
    s_ep1_busy = 1U;
    UEP1_T_LEN = 8U;
    UEP1_CTRL = (uint8_t)((UEP1_CTRL & ~MASK_UEP_T_RES) | UEP_T_RES_ACK);
    return 1U;
}

static void handle_ep0_setup(void) {
    uint8_t len = 0xFFU;
    uint8_t req_len = USB_RX_LEN;
    s_descr_ptr = 0;
    s_descr_is_xram = 0U;

    if (req_len == 8U) {
        s_setup_type = ep0_buf[0];
        s_setup_req = ep0_buf[1];
        s_setup_val_l = ep0_buf[2];
        s_setup_val_h = ep0_buf[3];
        s_setup_len = (uint16_t)ep0_buf[6] | ((uint16_t)ep0_buf[7] << 8);
        if ((s_setup_type & 0x60U) == 0x00U) {
            /* Standard USB Request */
            switch (s_setup_req) {
                case 0x06U: /* GET_DESCRIPTOR */
                    if (s_setup_val_h == 0x01U) {
                        s_descr_ptr = s_dev_desc;
                        len = sizeof(s_dev_desc);
                    } else if (s_setup_val_h == 0x02U) {
                        s_descr_ptr = s_cfg_desc;
                        len = sizeof(s_cfg_desc);
                    } else if (s_setup_val_h == 0x03U) {
                        if (s_setup_val_l == 0U) {
                            s_descr_ptr = s_lang_desc;
                            len = sizeof(s_lang_desc);
                        } else if (s_setup_val_l == 1U) {
                            s_descr_ptr = s_mfg_desc;
                            len = sizeof(s_mfg_desc);
                        } else if (s_setup_val_l == 2U) {
                            s_descr_ptr = s_prod_desc;
                            len = sizeof(s_prod_desc);
                        } else if (s_setup_val_l == 3U) {
                            s_descr_is_xram = 1U;
                            s_xram_ptr = serial_str_desc;
                            len = sizeof(serial_str_desc);
                        }
                    } else if (s_setup_val_h == 0x21U) {
                        s_descr_ptr = &s_cfg_desc[18];
                        len = 9U;
                    } else if (s_setup_val_h == 0x22U) {
                        s_descr_ptr = s_hid_report_desc;
                        len = sizeof(s_hid_report_desc);
                    }
                    break;
                case 0x05U: /* SET_ADDRESS */
                    s_usb_addr_pending = s_setup_val_l;
                    len = 0U;
                    break;
                case 0x08U: /* GET_CONFIGURATION */
                    ep0_buf[0] = s_usb_config;
                    len = 1U;
                    break;
                case 0x09U: /* SET_CONFIGURATION */
                    s_usb_config = s_setup_val_l;
                    UEP1_CTRL = bUEP_AUTO_TOG | UEP_R_RES_ACK | UEP_T_RES_NAK;
                    UEP1_T_LEN = 0U;
                    s_ep1_busy = 0U;
                    len = 0U;
                    break;
                case 0x00U: /* GET_STATUS */
                    ep0_buf[0] = 0U;
                    ep0_buf[1] = 0U;
                    len = 2U;
                    break;
                case 0x01U: /* CLEAR_FEATURE */
                    if (s_setup_val_l == 0U && (ep0_buf[4] & 0x7FU) == 0x01U) {
                        UEP1_CTRL = bUEP_AUTO_TOG | UEP_R_RES_ACK | UEP_T_RES_NAK;
                        s_ep1_busy = 0U;
                    }
                    len = 0U;
                    break;
                default:
                    break;
            }
        } else if ((s_setup_type & 0x60U) == 0x20U) {
            /* HID Class Request */
            if (s_setup_req == 0x01U && s_eng != 0) {
                /* GET_REPORT (Report ID in s_setup_val_l) */
                if (s_setup_val_l == G17_FEATURE_CAPS_ID) {
                    uint8_t tmp[16];
                    uint8_t k;
                    g17_engine_build_caps_feature(s_eng, tmp);
                    for (k = 0U; k < 16U; ++k) ep0_buf[k] = tmp[k];
                    len = 16U;
                } else if (s_setup_val_l == G17_FEATURE_STATE_ID) {
                    uint8_t tmp[8];
                    uint8_t k;
                    g17_engine_build_state_feature(s_eng, tmp);
                    for (k = 0U; k < 8U; ++k) ep0_buf[k] = tmp[k];
                    len = 8U;
                } else if (s_setup_val_l == G17_FEATURE_DIAG_ID) {
                    uint8_t tmp[32];
                    uint8_t k;
                    g17_engine_build_diag_feature(s_eng, tmp);
                    for (k = 0U; k < 32U; ++k) ep0_buf[k] = tmp[k];
                    len = 32U;
                }
            } else if (s_setup_req == 0x09U || s_setup_req == 0x0AU) {
                /* SET_REPORT or SET_IDLE */
                len = 0U;
            }
        }
    }

    if (len == 0xFFU) {
        UEP0_CTRL = bUEP_R_TOG | bUEP_T_TOG | UEP_R_RES_STALL | UEP_T_RES_STALL;
        return;
    }

    if (s_setup_len > len) {
        s_setup_len = len;
    }
    if (s_descr_ptr != 0 || s_descr_is_xram != 0U) {
        len = copy_ep0_chunk();
    } else {
        len = (uint8_t)s_setup_len;
        s_setup_len = 0U;
    }
    UEP0_T_LEN = len;
    UEP0_CTRL = bUEP_R_TOG | bUEP_T_TOG | UEP_R_RES_ACK | UEP_T_RES_ACK;
}

void usb_hid_isr(void) __interrupt(8) {
    uint8_t st;
    if (UIF_TRANSFER) {
        st = USB_INT_ST;
        switch (st & (MASK_UIS_TOKEN | MASK_UIS_ENDP)) {
            case UIS_TOKEN_IN | 1U:
                UEP1_T_LEN = 0U;
                UEP1_CTRL = (uint8_t)((UEP1_CTRL & ~MASK_UEP_T_RES) | UEP_T_RES_NAK);
                s_ep1_busy = 0U;
                break;
            case UIS_TOKEN_OUT | 1U:
                if (s_eng != 0 && USB_RX_LEN >= 3U) {
                    uint8_t n = (USB_RX_LEN > 64U) ? 64U : USB_RX_LEN;
                    g17_engine_handle_output_report(s_eng, ep1_buf, n);
                }
                break;
            case UIS_TOKEN_SETUP | 0U:
                handle_ep0_setup();
                break;
            case UIS_TOKEN_IN | 0U:
                if (s_setup_req == 0x05U) {
                    USB_DEV_AD = (uint8_t)((USB_DEV_AD & 0x80U) | s_usb_addr_pending);
                    UEP0_CTRL = UEP_R_RES_ACK | UEP_T_RES_NAK;
                } else if (s_setup_req == 0x06U) {
                    uint8_t len = copy_ep0_chunk();
                    UEP0_T_LEN = len;
                    UEP0_CTRL ^= bUEP_T_TOG;
                } else {
                    UEP0_T_LEN = 0U;
                    UEP0_CTRL = UEP_R_RES_ACK | UEP_T_RES_NAK;
                }
                break;
            case UIS_TOKEN_OUT | 0U:
                if (s_setup_req == 0x09U && s_eng != 0 && USB_RX_LEN >= 3U) {
                    uint8_t n = (USB_RX_LEN > 64U) ? 64U : USB_RX_LEN;
                    g17_engine_handle_output_report(s_eng, ep0_buf, n);
                }
                UEP0_CTRL = UEP_R_RES_ACK | UEP_T_RES_NAK;
                break;
            default:
                break;
        }
        UIF_TRANSFER = 0;
    }

    if (UIF_BUS_RST) {
        UEP0_CTRL = UEP_R_RES_ACK | UEP_T_RES_NAK;
        UEP1_CTRL = bUEP_AUTO_TOG | UEP_R_RES_ACK | UEP_T_RES_NAK;
        USB_DEV_AD = 0x00U;
        s_usb_config = 0U;
        s_ep1_busy = 0U;
        if (s_eng != 0) {
            g17_engine_set_usb_suspended(s_eng, 0U);
        }
        UIF_BUS_RST = 0;
    }

    if (UIF_SUSPEND) {
        UIF_SUSPEND = 0;
        /* NEVER enter Power-Down sleep (PCON |= 0x02): keep scanning alive, only dim LEDs. */
        if (s_eng != 0) {
            g17_engine_set_usb_suspended(s_eng, (USB_MIS_ST & bUMS_SUSPEND) ? 1U : 0U);
        }
    }
}
