#ifndef CH552_H
#define CH552_H

#include <stdint.h>

/* Core 8051 & Clock/Power SFRs (CH552) */
__sfr __at(0x87) PCON;
__sfr __at(0x88) TCON;
__sbit __at(0x8C) TR0;
__sbit __at(0x8D) TF0;
__sfr __at(0x89) TMOD;
__sfr __at(0x8A) TL0;
__sfr __at(0x8C) TH0;

__sfr __at(0x90) P1;
__sbit __at(0x95) P1_5; /* MOSI / LED_BUS */
__sfr __at(0x92) P1_MOD_OC;
__sfr __at(0x93) P1_DIR_PU;

__sfr __at(0x96) P3_MOD_OC;
__sfr __at(0x97) P3_DIR_PU;

__sfr __at(0xA1) SAFE_MOD;
__sfr __at(0xA8) IE;
__sbit __at(0xA9) ET0;
__sbit __at(0xAF) EA;
__sfr __at(0xA9) WAKE_CTRL;

__sfr __at(0xB0) P3;
__sbit __at(0xB0) P3_0; /* K1 */
__sbit __at(0xB1) P3_1; /* K2 */
__sbit __at(0xB2) P3_2; /* K3 */
__sbit __at(0xB3) P3_3; /* K5 */
__sbit __at(0xB4) P3_4; /* K4 */

__sfr __at(0xB1) GLOBAL_CFG;
__sfr __at(0xB9) CLOCK_CFG;

/* TouchKey SFRs */
__sfr __at(0xC3) TKEY_CTRL;
__sfr __at(0xC4) TKEY_DATL;
__sfr __at(0xC5) TKEY_DATH;

/* USB Device SFRs (CH552) */
__sfr __at(0xD1) UDEV_CTRL;
__sfr __at(0xD2) UEP1_CTRL;
__sfr __at(0xD3) UEP1_T_LEN;
__sfr __at(0xD8) USB_INT_FG;
__sbit __at(0xD8) UIF_BUS_RST;
__sbit __at(0xD9) UIF_TRANSFER;
__sbit __at(0xDA) UIF_SUSPEND;
__sbit __at(0xDB) UIF_FIFO_OV;

__sfr __at(0xD9) USB_INT_ST;
__sfr __at(0xDA) USB_MIS_ST;
__sfr __at(0xDB) USB_RX_LEN;
__sfr __at(0xDC) UEP0_CTRL;
__sfr __at(0xDD) UEP0_T_LEN;

__sfr __at(0xE1) USB_INT_EN;
__sfr __at(0xE2) USB_CTRL;
__sfr __at(0xE3) USB_DEV_AD;

__sfr __at(0xE8) IE_EX;
__sbit __at(0xEA) IE_USB;
__sfr __at(0xEA) UEP4_1_MOD;
__sfr __at(0xEC) UEP0_DMA_L;
__sfr __at(0xED) UEP0_DMA_H;
__sfr __at(0xEE) UEP1_DMA_L;
__sfr __at(0xEF) UEP1_DMA_H;

__sfr __at(0xFF) WDOG_COUNT;

/* Register bit masks */
#define bRST         0x08U
#define bTKC_IF      0x80U
#define bTKC_2MS     0x10U

#define bUC_DEV_PU_EN 0x20U
#define bUC_INT_BUSY  0x08U
#define bUC_RESET_SIE 0x04U
#define bUC_CLR_ALL   0x02U
#define bUC_DMA_EN    0x01U

#define bUD_PD_DIS    0x80U
#define bUD_DP_PIN    0x20U
#define bUD_DM_PIN    0x10U
#define bUD_LOW_SPEED 0x04U
#define bUD_GP_BIT    0x02U
#define bUD_PORT_EN   0x01U

#define bUIE_SUSPEND  0x04U
#define bUIE_TRANSFER 0x02U
#define bUIE_BUS_RST  0x01U

#define bUMS_SUSPEND  0x04U

#define MASK_UIS_TOKEN 0x30U
#define MASK_UIS_ENDP  0x0FU
#define UIS_TOKEN_OUT  0x00U
#define UIS_TOKEN_SOF  0x10U
#define UIS_TOKEN_IN   0x20U
#define UIS_TOKEN_SETUP 0x30U

#define bUEP_R_TOG    0x80U
#define bUEP_T_TOG    0x40U
#define bUEP_AUTO_TOG 0x10U
#define MASK_UEP_R_RES 0x0CU
#define MASK_UEP_T_RES 0x03U
#define UEP_R_RES_ACK  0x00U
#define UEP_R_RES_NAK  0x02U
#define UEP_R_RES_STALL 0x03U
#define UEP_T_RES_ACK  0x00U
#define UEP_T_RES_NAK  0x02U
#define UEP_T_RES_STALL 0x03U

#define bUEP1_TX_EN   0x40U
#define bUEP1_RX_EN   0x80U
#define bUEP1_BUF_MOD 0x10U

#endif
